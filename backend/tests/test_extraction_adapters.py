import json
import struct
import zipfile
from io import BytesIO, StringIO

import ezdxf

from app.services.extractions import SourceProcessingError, parse_source


def _docx_bytes():
    document = b"""<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>Tank TK-01 has nominal capacity 12 m3.</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Design pressure</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>0.8 MPa</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body>
    </w:document>"""
    archive = BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("word/document.xml", document)
    return archive.getvalue()


def _glb_bytes():
    binary = (
        struct.pack("<9f", 0, 0, 0, 2, 0, 0, 0, 3, 0)
        + struct.pack("<3H", 0, 1, 2)
    )
    document = {
        "asset": {"version": "2.0", "generator": "test fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {"name": "Assembly", "children": [1], "translation": [10, 0, 0], "extras": {"zone": "A"}},
            {"name": "Object_00482", "mesh": 0, "translation": [0, 4, 0]},
        ],
        "meshes": [{"name": "Triangle", "primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 6},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [2, 3, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
    }
    json_chunk = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    body = struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
    body += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body


def test_text_and_docx_extract_source_locations_and_tables():
    text = parse_source("notes.txt", b"Pump P-1\nRated flow 3 L/s\n")
    assert text.source_type == "document"
    assert "[line:2] Rated flow 3 L/s" in text.content
    assert text.evidence[1]["source_id"] == "line:2"

    docx = parse_source("spec.docx", _docx_bytes())
    assert docx.extraction_method == "docx_xml"
    assert any(block["source_id"].startswith("table:1:row:1") for block in docx.evidence)
    assert "0.8 MPa" in docx.content


def test_dxf_extracts_entities_layers_blocks_and_dimensions():
    document = ezdxf.new()
    document.layers.new("EQUIPMENT")
    modelspace = document.modelspace()
    modelspace.add_line((0, 0), (10, 0), dxfattribs={"layer": "EQUIPMENT"})
    modelspace.add_text("TK-01", dxfattribs={"layer": "EQUIPMENT"}).set_placement((1, 2))
    block = document.blocks.new("PUMP")
    block.add_circle((0, 0), radius=1)
    modelspace.add_blockref("PUMP", (3, 3))
    modelspace.add_linear_dim(base=(0, 2), p1=(0, 0), p2=(10, 0)).render()
    stream = StringIO()
    document.write(stream)

    parsed = parse_source("layout.dxf", stream.getvalue().encode("utf-8"))
    assert parsed.source_type == "drawing"
    assert parsed.extraction_method == "ezdxf"
    assert any(layer["name"] == "EQUIPMENT" for layer in parsed.parsed_data["layers"])
    assert any(entity["type"] == "LINE" for entity in parsed.parsed_data["entities"])
    assert any(entity.get("text") == "TK-01" for entity in parsed.parsed_data["labels"])
    assert any(block["name"] == "PUMP" for block in parsed.parsed_data["blocks"])
    assert any(entity["type"] == "INSERT" for entity in parsed.parsed_data["entities"])
    assert parsed.parsed_data["dimensions"]


def test_glb_extracts_hierarchy_world_transform_bounds_and_connectivity():
    parsed = parse_source("model.glb", _glb_bytes())
    root, child = parsed.parsed_data["nodes"]

    assert root["source_id"] == "node:0"
    assert root["child_node_indices"] == [1]
    assert child["parent_node_index"] == 0
    assert child["mesh_index"] == 0
    assert child["world_transform"][12:15] == [10, 4, 0]
    assert child["bounding_box"]["dimensions"] == [2, 3, 0]
    assert child["geometry_reference"]["primitives"][0]["index_data"]["connectivity_sample"] == [0, 1, 2]
    assert child["geometry_reference"]["primitives"][0]["vertex_count"] == 3


def test_gltf_external_buffers_are_resolved_from_the_uploaded_bundle():
    scene = {
        "asset": {"version": "2.0"},
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "buffers": [{"uri": "mesh.bin", "byteLength": 36}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 1]}],
    }
    parsed = parse_source(
        "scene.gltf",
        json.dumps(scene).encode("utf-8"),
        {"mesh.bin": struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 1)},
    )
    assert parsed.parsed_data["external_buffer_names"] == ["mesh.bin"]
    assert parsed.parsed_data["nodes"][0]["bounding_box"]["dimensions"] == [1, 1, 1]


def test_unsupported_and_missing_glb_buffers_fail_explicitly():
    try:
        parse_source("assembly.step", b"STEP")
    except SourceProcessingError as exc:
        assert "Unsupported file format" in str(exc)
    else:
        raise AssertionError("Unsupported formats must not be reported as parsed.")

    with_error = {
        "asset": {"version": "2.0"},
        "buffers": [{"uri": "missing.bin", "byteLength": 4}],
    }
    try:
        parse_source("scene.gltf", json.dumps(with_error).encode("utf-8"))
    except SourceProcessingError as exc:
        assert "not included" in str(exc)
    else:
        raise AssertionError("Missing external assets must be reported.")
