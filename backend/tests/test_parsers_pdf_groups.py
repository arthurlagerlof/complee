import json
import struct
import uuid

import pytest

from app.ai.schemas import ExtractionResult
from app.db.models import SourceDocument
from app.services import ai
from app.services.extractions import SourceProcessingError, parse_source


def _pdf(pages: list[list[str]]) -> bytes:
    """Minimal text PDF (Helvetica, one text line per entry) built by hand for the parser tests."""
    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    page_ids = [4 + 2 * i for i in range(len(pages))]
    objects[2] = f"<< /Type /Pages /Kids [{' '.join(f'{p} 0 R' for p in page_ids)}] /Count {len(pages)} >>".encode()
    for i, lines in enumerate(pages):
        stream = "\n".join(f"BT /F1 12 Tf 72 {750 - 20 * n} Td ({line}) Tj ET" for n, line in enumerate(lines)).encode()
        objects[5 + 2 * i] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
        objects[page_ids[i]] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
                                f"/Contents {5 + 2 * i} 0 R >>").encode()
    out, offsets = b"%PDF-1.4\n", {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode() + objects[number] + b"\nendobj\n"
    xref, size = len(out), max(objects) + 1
    out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offsets[i]:010d} 00000 n \n".encode() for i in range(1, size))
    out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def test_pdf_text_is_extracted_per_line_with_page_numbers():
    parsed = parse_source("spec.pdf", _pdf([["Fuel oil system", "FO transfer pipe material: steel"], [], ["Door D-12 clear width 760 mm"]]))
    assert parsed.extraction_method == "pdf_text" and parsed.source_type == "document"
    blocks = parsed.parsed_data["blocks"]
    assert {b["source_id"] for b in blocks} >= {"page:1:line:1", "page:1:line:2", "page:3:line:1"}
    assert next(b for b in blocks if "760 mm" in b["text"])["page"] == 3
    assert parsed.parsed_data["pages_without_text"] == [2]
    assert "[page:1:line:2] FO transfer pipe material: steel" in parsed.content


def test_pdf_without_text_or_damaged_is_reported_not_guessed():
    with pytest.raises(SourceProcessingError, match="No text layer"):
        parse_source("scan.pdf", _pdf([[]]))
    with pytest.raises(SourceProcessingError, match="Could not read"):
        parse_source("broken.pdf", b"%PDF-1.4 not really a pdf")


def _glb(document: dict, binary: bytes) -> bytes:
    json_chunk = json.dumps(document, separators=(",", ":")).encode()
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    body = struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body


def _tank_model() -> bytes:
    binary = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0) + struct.pack("<3H", 0, 1, 2)
    # The parent (index 3) comes after its children: world transforms must still resolve.
    document = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [3]}],
        "nodes": [
            {"name": "Tank shell", "mesh": 0, "translation": [0, 0, 0]},
            {"name": "Tank top", "mesh": 0, "translation": [0, 2, 0]},
            {"name": "Supports", "children": [4]},
            {"name": "FO TK 01", "children": [0, 1, 2], "translation": [10, 0, 0], "extras": {"system": "fuel oil"}},
            {"name": "Support leg", "mesh": 0, "translation": [0, -1, 0]},
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}, {"buffer": 0, "byteOffset": 36, "byteLength": 6}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
    }
    return _glb(document, binary)


def test_gltf_branch_groups_aggregate_children_and_resolve_parents_declared_later():
    parsed = parse_source("tank.glb", _tank_model())
    nodes = {n["node_index"]: n for n in parsed.parsed_data["nodes"]}
    assert nodes[1]["world_transform"][12:15] == [10, 2, 0]
    assert nodes[4]["world_transform"][12:15] == [10, -1, 0]
    groups = {g["source_id"]: g for g in parsed.parsed_data["groups"]}
    tank = groups["group:node:3"]
    assert tank["child_names"] == ["Tank shell", "Tank top", "Supports"]
    assert sorted(tank["mesh_node_indices"]) == [0, 1, 4]
    assert tank["triangle_count"] == 3 and tank["descendant_count"] == 4
    assert tank["bounding_box"]["min"] == [10, -1, 0] and tank["bounding_box"]["max"] == [11, 3, 0]
    assert tank["metadata"] == {"system": "fuel oil"}
    assert groups["group:node:2"]["path"] == ["FO TK 01"]
    assert parsed.content.startswith("MODEL BRANCHES")
    assert any(e["source_id"] == "group:node:3" for e in parsed.evidence)


def test_a_cited_branch_grounds_and_maps_to_its_mesh_nodes(api_client):
    parsed = parse_source("tank.glb", _tank_model())
    with api_client.TestSession() as session:
        document = SourceDocument(revision_id=uuid.UUID(_revision_id(api_client)), filename="tank.glb", file_extension=".glb",
                                  sha256="0" * 64, source_data=b"x", parsed_data=parsed.parsed_data, processing_status="completed")
        session.add(document)
        session.commit()
        result = ExtractionResult.model_validate({"components": [{
            "component_type": "fuel_tank", "name": "FO TK 01", "properties": {},
            "evidence": [{"text": "FO TK 01 assembly", "source_id": "group:node:3"}], "confidence": 0.7, "review_status": "pending"}],
            "relationships": [], "warnings": []})
        ai._ground_extraction_evidence(session, result, document.id)
        ai._attach_geometry_references(session, result, document.id)
    candidate = result.components[0]
    assert candidate.evidence and candidate.evidence[0].source_id == "group:node:3"
    reference = candidate.geometry_reference
    assert reference["groups"] == ["group:node:3"]
    assert sorted(n["node_index"] for n in reference["nodes"]) == [0, 1, 3, 4]


def _revision_id(client) -> str:
    project = client.post("/api/v1/projects", json={"name": "Parsers"}).json()
    vessel = client.post("/api/v1/vessels", json={"project_id": project["id"], "name": "V"}).json()
    return client.post("/api/v1/design-revisions", json={"vessel_id": vessel["id"], "revision_name": "R1", "revision_number": 1}).json()["id"]
