import base64
import hashlib
import json
import math
import struct
import zipfile
from dataclasses import dataclass
from io import BytesIO, StringIO
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree


MAX_ENTITIES = 10_000
MAX_NODES = 10_000
MAX_SOURCE_CHARACTERS = 1_000_000
MAX_AI_ITEMS = 500
MAX_PDF_PAGES = 2_000
MAX_GROUPS = 300
_DOCX_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
}


class SourceProcessingError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedSource:
    source_type: str
    extraction_method: str
    content: str
    evidence: list[dict[str, Any]]
    parsed_data: dict[str, Any]


def parse_source(
    filename: str,
    data: bytes,
    related_files: dict[str, bytes] | None = None,
) -> ParsedSource:
    suffix = PurePosixPath(filename.replace("\\", "/")).suffix.lower()
    if not data:
        raise SourceProcessingError("The uploaded file is empty.")
    if suffix == ".txt":
        return _parse_text(data)
    if suffix == ".docx":
        return _parse_docx(data)
    if suffix == ".pdf":
        return _parse_pdf(data)
    if suffix == ".dxf":
        return _parse_dxf(data)
    if suffix in {".glb", ".gltf"}:
        return _parse_gltf(data, suffix, related_files or {})
    raise SourceProcessingError(
        "Unsupported file format. Supported formats are TXT, DOCX, PDF (text-based), DXF, GLB and GLTF."
    )


def _limit_content(content: str) -> str:
    if len(content) > MAX_SOURCE_CHARACTERS:
        raise SourceProcessingError(
            f"Extracted source exceeds the {MAX_SOURCE_CHARACTERS:,}-character processing limit."
        )
    return content


def _parse_text(data: bytes) -> ParsedSource:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SourceProcessingError("Text files must use UTF-8 encoding.") from exc
    blocks = [
        {"source_id": f"line:{line_number}", "text": line}
        for line_number, line in enumerate(text.splitlines(), start=1)
        if line.strip()
    ]
    content = "\n".join(f"[{block['source_id']}] {block['text']}" for block in blocks)
    _limit_content(content)
    return ParsedSource(
        source_type="document",
        extraction_method="plain_text",
        content=content,
        evidence=blocks[:MAX_ENTITIES],
        parsed_data={"format": "txt", "line_count": len(text.splitlines()), "blocks": blocks[:MAX_ENTITIES]},
    )


def _xml_text(element: ElementTree.Element) -> str:
    return "".join(node.text or "" for node in element.findall(".//w:t", _DOCX_NS)).strip()


def _parse_docx(data: bytes) -> ParsedSource:
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            if archive.getinfo("word/document.xml").file_size > 20 * 1024 * 1024:
                raise SourceProcessingError("The DOCX document content exceeds the 20 MB parser limit.")
            xml = archive.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise SourceProcessingError("Could not read the DOCX document content.") from exc
    if b"<!DOCTYPE" in xml.upper():
        raise SourceProcessingError("DOCX documents containing a document type declaration are not supported.")
    try:
        document = ElementTree.fromstring(xml)
    except ElementTree.ParseError as exc:
        raise SourceProcessingError("The DOCX document contains invalid XML.") from exc

    body = document.find("w:body", _DOCX_NS)
    if body is None:
        raise SourceProcessingError("The DOCX document does not contain a readable body.")
    blocks: list[dict[str, Any]] = []
    paragraph_number = 0
    table_number = 0
    for element in body:
        if element.tag.endswith("}p"):
            paragraph_number += 1
            text = _xml_text(element)
            if text:
                blocks.append({"source_id": f"paragraph:{paragraph_number}", "text": text})
        elif element.tag.endswith("}tbl"):
            table_number += 1
            rows = []
            for row_number, row in enumerate(element.findall("w:tr", _DOCX_NS), start=1):
                cells = []
                for column_number, cell in enumerate(row.findall("w:tc", _DOCX_NS), start=1):
                    text = _xml_text(cell)
                    cells.append(text)
                    if text:
                        blocks.append(
                            {
                                "source_id": (
                                    f"table:{table_number}:row:{row_number}:column:{column_number}"
                                ),
                                "text": text,
                            }
                        )
                rows.append(cells)
            blocks.append({"source_id": f"table:{table_number}", "rows": rows})
    evidence = [block for block in blocks if "text" in block]
    content = "\n".join(
        f"[{block['source_id']}] {block['text']}" for block in evidence
    )
    _limit_content(content)
    if not content.strip():
        raise SourceProcessingError("No readable text or tables were found in this DOCX.")
    return ParsedSource(
        source_type="document",
        extraction_method="docx_xml",
        content=content,
        evidence=evidence,
        parsed_data={"format": "docx", "blocks": blocks[:MAX_ENTITIES]},
    )


def _parse_pdf(data: bytes) -> ParsedSource:
    """Text of a text-based PDF, one evidence block per text line with its page number. Scanned pages without a
    text layer are reported, not guessed (no OCR)."""
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
    except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
        raise SourceProcessingError("PDF parsing needs the pypdf package (pip install -r requirements.txt).") from exc
    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise SourceProcessingError("Password-protected PDFs are not supported.")
        pages = list(reader.pages)
    except (PdfReadError, ValueError, KeyError, OSError) as exc:
        raise SourceProcessingError("Could not read the PDF document.") from exc
    if len(pages) > MAX_PDF_PAGES:
        raise SourceProcessingError(f"The PDF has more than {MAX_PDF_PAGES} pages.")
    blocks: list[dict[str, Any]] = []
    pages_without_text: list[int] = []
    for page_number, page in enumerate(pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 - one unreadable page must not discard the others
            text = ""
        # PDF text has visual lines, not reliable paragraphs: one block per line, like TXT sources.
        lines = [" ".join(line.split()) for line in text.replace("\r", "").split("\n")]
        lines = [line for line in lines if line]
        if not lines:
            pages_without_text.append(page_number)
        for line_number, line in enumerate(lines, start=1):
            blocks.append({"source_id": f"page:{page_number}:line:{line_number}", "page": page_number, "text": line})
    if not blocks:
        raise SourceProcessingError("No text layer was found in this PDF (scanned drawings need OCR, which is not supported).")
    content = "\n".join(f"[{block['source_id']}] {block['text']}" for block in blocks)
    _limit_content(content)
    return ParsedSource(
        source_type="document",
        extraction_method="pdf_text",
        content=content,
        evidence=blocks[:MAX_ENTITIES],
        parsed_data={"format": "pdf", "page_count": len(pages), "pages_without_text": pages_without_text,
                     "blocks": blocks[:MAX_ENTITIES]},
    )


def _parse_dxf(data: bytes) -> ParsedSource:
    try:
        import ezdxf
    except ImportError as exc:
        raise SourceProcessingError("DXF parsing is unavailable; install the declared ezdxf dependency.") from exc
    try:
        text = data.decode("utf-8-sig")
        document = ezdxf.read(StringIO(text))
    except (UnicodeDecodeError, ezdxf.DXFError) as exc:
        raise SourceProcessingError("Could not parse this DXF drawing.") from exc

    layers = [
        {
            "name": layer.dxf.name,
            "color": layer.dxf.color,
            "linetype": layer.dxf.linetype,
            "is_on": not layer.is_off(),
            "is_frozen": layer.is_frozen(),
        }
        for layer in document.layers
    ]
    blocks = []
    for block in document.blocks:
        if block.name.startswith("*"):
            continue
        blocks.append(
            {
                "name": block.name,
                "entities": [
                    _dxf_entity(entity)
                    for entity in list(block)[:MAX_ENTITIES]
                ],
            }
        )
    entities = [_dxf_entity(entity) for entity in list(document.modelspace())[:MAX_ENTITIES]]
    dimensions = [entity for entity in entities if entity["type"] == "DIMENSION"]
    labels = [
        entity for entity in entities
        if entity["type"] in {"TEXT", "MTEXT", "ATTRIB", "ATTDEF"}
    ]
    content = "\n".join(
        json.dumps(entity, ensure_ascii=False, separators=(",", ":"))
        for entity in entities[:MAX_AI_ITEMS]
    )
    _limit_content(content)
    if not entities:
        raise SourceProcessingError("The DXF drawing contains no model-space entities.")
    return ParsedSource(
        source_type="drawing",
        extraction_method="ezdxf",
        content=content,
        evidence=[
            {
                "source_id": entity["source_id"],
                "text": entity.get("text") or entity["type"],
            }
            for entity in entities
        ],
        parsed_data={
            "format": "dxf",
            "layers": layers,
            "blocks": blocks,
            "entities": entities,
            "dimensions": dimensions,
            "labels": labels,
            "truncated": len(list(document.modelspace())) > MAX_ENTITIES,
            "ai_interpretation_truncated": len(entities) > MAX_AI_ITEMS,
        },
    )


def _dxf_entity(entity: Any) -> dict[str, Any]:
    attributes: dict[str, Any] = {}
    for key in ("insert", "start", "end", "center", "radius", "text", "height", "rotation", "name"):
        if entity.dxf.hasattr(key):
            value = entity.dxf.get(key)
            if hasattr(value, "x") and hasattr(value, "y"):
                attributes[key] = [float(value.x), float(value.y), float(getattr(value, "z", 0))]
            elif isinstance(value, (str, int, float, bool)):
                attributes[key] = value
    if entity.dxftype() in {"LWPOLYLINE", "POLYLINE"}:
        points = []
        try:
            points = [[float(value) for value in point[:2]] for point in entity.get_points("xy")]
        except (AttributeError, TypeError, ValueError):
            try:
                points = [
                    [float(vertex.dxf.location.x), float(vertex.dxf.location.y), float(vertex.dxf.location.z)]
                    for vertex in entity.vertices
                ]
            except (AttributeError, TypeError):
                points = []
        if points:
            attributes["vertices"] = points[:MAX_ENTITIES]
    if entity.dxftype() == "INSERT":
        attributes["block_name"] = entity.dxf.name
    return {
        "source_id": str(entity.dxf.get("handle", "")),
        "type": entity.dxftype(),
        "layer": entity.dxf.get("layer", "0"),
        "attributes": attributes,
        **({"text": attributes["text"]} if "text" in attributes else {}),
    }


def _glb_json_and_binary(data: bytes) -> tuple[dict[str, Any], bytes | None]:
    if len(data) < 12:
        raise SourceProcessingError("The GLB file header is incomplete.")
    magic, version, declared_length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or declared_length != len(data):
        raise SourceProcessingError("Only valid glTF 2.0 binary files are supported.")
    offset = 12
    document = None
    binary = None
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<I4s", data, offset)
        offset += 8
        chunk_end = offset + chunk_length
        if chunk_end > len(data):
            raise SourceProcessingError("The GLB file contains a truncated chunk.")
        if chunk_type == b"JSON":
            try:
                document = json.loads(data[offset:chunk_end].decode("utf-8").rstrip(" \0"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise SourceProcessingError("The GLB JSON chunk is invalid.") from exc
        elif chunk_type == b"BIN\0":
            binary = data[offset:chunk_end]
        offset = chunk_end
    if not isinstance(document, dict):
        raise SourceProcessingError("The GLB file does not contain a JSON scene.")
    return document, binary


def _gltf_json_and_buffers(
    data: bytes,
    suffix: str,
    related_files: dict[str, bytes],
) -> tuple[dict[str, Any], list[bytes]]:
    binary = None
    if suffix == ".glb":
        document, binary = _glb_json_and_binary(data)
    else:
        try:
            document = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SourceProcessingError("The GLTF scene file contains invalid JSON.") from exc
    if not isinstance(document, dict):
        raise SourceProcessingError("The GLTF scene must be a JSON object.")
    if not isinstance(document.get("asset"), dict) or document["asset"].get("version") != "2.0":
        raise SourceProcessingError("Only glTF 2.0 scene files are supported.")

    resources = {PurePosixPath(name.replace("\\", "/")).name: value for name, value in related_files.items()}
    buffers: list[bytes] = []
    for index, buffer in enumerate(document.get("buffers", [])):
        uri = buffer.get("uri") if isinstance(buffer, dict) else None
        if uri is None:
            if index != 0 or binary is None:
                raise SourceProcessingError("A GLTF buffer is missing its embedded or uploaded data file.")
            value = binary
        elif uri.startswith("data:"):
            try:
                header, encoded = uri.split(",", 1)
                if ";base64" not in header:
                    raise ValueError
                value = base64.b64decode(encoded, validate=True)
            except (ValueError, base64.binascii.Error) as exc:
                raise SourceProcessingError("A GLTF data URI is invalid.") from exc
        else:
            parsed_uri = urlsplit(uri)
            if parsed_uri.scheme or parsed_uri.netloc:
                raise SourceProcessingError("Remote GLTF buffer URIs are not fetched.")
            resource_name = PurePosixPath(unquote(parsed_uri.path)).name
            value = resources.get(resource_name)
            if value is None:
                raise SourceProcessingError(
                    f"GLTF references '{resource_name}', which was not included in this upload."
                )
        declared_length = buffer.get("byteLength", len(value))
        if len(value) < declared_length:
            raise SourceProcessingError("A GLTF buffer is shorter than its declared length.")
        buffers.append(value)
    return document, buffers


_COMPONENT_FORMATS = {
    5120: ("b", 1),
    5121: ("B", 1),
    5122: ("h", 2),
    5123: ("H", 2),
    5125: ("I", 4),
    5126: ("f", 4),
}
_ACCESSOR_WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _accessor_values(
    document: dict[str, Any],
    buffers: list[bytes],
    accessor_index: int,
    max_items: int = 0,
) -> list[Any]:
    accessors = document.get("accessors", [])
    views = document.get("bufferViews", [])
    if accessor_index < 0 or accessor_index >= len(accessors):
        return []
    accessor = accessors[accessor_index]
    if "bufferView" not in accessor:
        return []
    view = views[accessor["bufferView"]]
    component_format = _COMPONENT_FORMATS.get(accessor.get("componentType"))
    width = _ACCESSOR_WIDTHS.get(accessor.get("type"))
    if component_format is None or width is None:
        return []
    fmt, component_size = component_format
    stride = view.get("byteStride", component_size * width)
    count = accessor.get("count", 0)
    count = min(count, max_items) if max_items else count
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    buffer = buffers[view.get("buffer", 0)]
    values = []
    for index in range(count):
        offset = start + index * stride
        if offset + component_size * width > len(buffer):
            raise SourceProcessingError("A GLTF accessor extends beyond its buffer.")
        row = struct.unpack_from("<" + fmt * width, buffer, offset)
        values.append(row[0] if width == 1 else list(row))
    return values


def _accessor_bounds(
    document: dict[str, Any], buffers: list[bytes], accessor_index: int
) -> dict[str, list[float]] | None:
    if accessor_index < 0 or accessor_index >= len(document.get("accessors", [])):
        return None
    accessor = document.get("accessors", [])[accessor_index]
    minimum = accessor.get("min")
    maximum = accessor.get("max")
    if minimum is not None and maximum is not None:
        return {
            "min": [float(value) for value in minimum],
            "max": [float(value) for value in maximum],
        }
    positions = _accessor_values(document, buffers, accessor_index)
    points = [point for point in positions if isinstance(point, list) and len(point) >= 3]
    if not points:
        return None
    return {
        "min": [min(float(point[axis]) for point in points) for axis in range(3)],
        "max": [max(float(point[axis]) for point in points) for axis in range(3)],
    }


def _matrix_multiply(left: list[float], right: list[float]) -> list[float]:
    return [
        sum(left[row + 4 * inner] * right[inner + 4 * column] for inner in range(4))
        for column in range(4)
        for row in range(4)
    ]


def _node_local_matrix(node: dict[str, Any]) -> list[float]:
    if isinstance(node.get("matrix"), list) and len(node["matrix"]) == 16:
        return [float(value) for value in node["matrix"]]
    translation = node.get("translation", [0, 0, 0])
    rotation = node.get("rotation", [0, 0, 0, 1])
    scale = node.get("scale", [1, 1, 1])
    x, y, z, w = [float(value) for value in rotation]
    sx, sy, sz = [float(value) for value in scale]
    tx, ty, tz = [float(value) for value in translation]
    return [
        (1 - 2 * (y * y + z * z)) * sx,
        (2 * (x * y + z * w)) * sx,
        (2 * (x * z - y * w)) * sx,
        0,
        (2 * (x * y - z * w)) * sy,
        (1 - 2 * (x * x + z * z)) * sy,
        (2 * (y * z + x * w)) * sy,
        0,
        (2 * (x * z + y * w)) * sz,
        (2 * (y * z - x * w)) * sz,
        (1 - 2 * (x * x + y * y)) * sz,
        0,
        tx,
        ty,
        tz,
        1,
    ]


def _transform_point(matrix: list[float], point: list[float]) -> list[float]:
    x, y, z = point
    result = [
        matrix[row] * x + matrix[row + 4] * y + matrix[row + 8] * z + matrix[row + 12]
        for row in range(3)
    ]
    return [value if math.isfinite(value) else 0 for value in result]


def _mesh_data(document: dict[str, Any], buffers: list[bytes]) -> list[dict[str, Any]]:
    materials = document.get("materials", [])
    meshes = []
    for mesh_index, mesh in enumerate(document.get("meshes", [])):
        primitives = []
        for primitive_index, primitive in enumerate(mesh.get("primitives", [])):
            attributes = primitive.get("attributes", {})
            position_index = attributes.get("POSITION")
            bounds = (
                _accessor_bounds(document, buffers, position_index)
                if isinstance(position_index, int) and position_index >= 0
                else None
            )
            index_accessor = primitive.get("indices")
            index_accessor_data = None
            if isinstance(index_accessor, int):
                accessor = document.get("accessors", [])[index_accessor]
                index_accessor_data = {
                    "accessor_index": index_accessor,
                    "count": accessor.get("count", 0),
                    "component_type": accessor.get("componentType"),
                    "connectivity_sample": _accessor_values(
                        document, buffers, index_accessor, max_items=96
                    ),
                }
            material_index = primitive.get("material")
            primitives.append(
                {
                    "primitive_index": primitive_index,
                    "mode": primitive.get("mode", 4),
                    "attributes": attributes,
                    "position_accessor": position_index,
                    "vertex_count": (
                        document["accessors"][position_index].get("count")
                        if isinstance(position_index, int)
                        and 0 <= position_index < len(document.get("accessors", []))
                        else None
                    ),
                    "bounds": bounds,
                    "index_data": index_accessor_data,
                    "material_index": material_index,
                    "material": (
                        materials[material_index]
                        if isinstance(material_index, int) and material_index < len(materials)
                        else None
                    ),
                }
            )
        meshes.append(
            {
                "mesh_index": mesh_index,
                "name": mesh.get("name"),
                "extras": mesh.get("extras", {}),
                "primitives": primitives,
            }
        )
    return meshes


def _triangles(primitive: dict[str, Any]) -> int:
    if primitive.get("mode", 4) != 4:
        return 0
    count = (primitive.get("index_data") or {}).get("count") or primitive.get("vertex_count") or 0
    return int(count) // 3


def _branch_groups(parsed_nodes: list[dict[str, Any]], meshes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic assemblies: every node with children whose subtree contains geometry, with its path, direct
    children, aggregated world bounds and geometry totals. Groups describe structure only; they are not components."""
    by_index = {node["node_index"]: node for node in parsed_nodes}
    groups = []
    for node in parsed_nodes:
        children = [c for c in node["child_node_indices"] if isinstance(c, int) and c in by_index]
        if not children:
            continue
        stack, members, seen = list(children), [], set()
        while stack:
            index = stack.pop()
            if index in seen:
                continue
            seen.add(index)
            member = by_index[index]
            members.append(member)
            stack.extend(c for c in member["child_node_indices"] if isinstance(c, int) and c in by_index)
        mesh_members = [m for m in [node, *members] if m["bounding_box"]]
        if not mesh_members:
            continue
        triangles = vertices = 0
        for member in mesh_members:
            index = member["mesh_index"]
            mesh = meshes[index] if isinstance(index, int) and 0 <= index < len(meshes) else None
            for primitive in (mesh or {}).get("primitives", []):
                triangles += _triangles(primitive)
                vertices += primitive.get("vertex_count") or 0
        minimum = [min(m["bounding_box"]["min"][axis] for m in mesh_members) for axis in range(3)]
        maximum = [max(m["bounding_box"]["max"][axis] for m in mesh_members) for axis in range(3)]
        path, parent = [], node["parent_node_index"]
        while parent is not None and len(path) < 20:
            path.append(by_index[parent]["name"] or f"node {parent}")
            parent = by_index[parent]["parent_node_index"]
        groups.append({
            "source_id": f"group:node:{node['node_index']}",
            "node_index": node["node_index"],
            "name": node["name"],
            "path": list(reversed(path)),
            "depth": len(path),
            "child_names": [by_index[c]["name"] for c in children][:24],
            "descendant_count": len(members),
            "mesh_node_indices": [m["node_index"] for m in mesh_members][:500],
            "triangle_count": triangles,
            "vertex_count": vertices,
            "bounding_box": {"min": minimum, "max": maximum, "dimensions": [maximum[a] - minimum[a] for a in range(3)]},
            "metadata": node["metadata"],
        })
    groups.sort(key=lambda g: (g["depth"], g["node_index"]))
    return groups[:MAX_GROUPS]


def _parse_gltf(data: bytes, suffix: str, related_files: dict[str, bytes]) -> ParsedSource:
    document, buffers = _gltf_json_and_buffers(data, suffix, related_files)
    source_model_id = hashlib.sha256(data).hexdigest()
    nodes = document.get("nodes", [])
    if not isinstance(nodes, list) or len(nodes) > MAX_NODES:
        raise SourceProcessingError(f"GLTF node count exceeds the {MAX_NODES:,}-node limit.")
    meshes = _mesh_data(document, buffers)
    parents: dict[int, int] = {}
    for parent_index, node in enumerate(nodes):
        for child_index in node.get("children", []):
            if isinstance(child_index, int) and 0 <= child_index < len(nodes):
                parents[child_index] = parent_index

    parsed_nodes: list[dict[str, Any]] = []
    world_matrices: dict[int, list[float]] = {}

    def world_matrix(index: int) -> list[float]:
        # glTF does not require parents to have lower indices: resolve the ancestor chain first.
        chain: list[int] = []
        current: int | None = index
        while current is not None and current not in world_matrices:
            if current in chain:
                raise SourceProcessingError("The GLTF node hierarchy contains a cycle.")
            chain.append(current)
            current = parents.get(current)
        matrix = world_matrices[current] if current is not None else None
        for item in reversed(chain):
            local_matrix = _node_local_matrix(nodes[item])
            matrix = _matrix_multiply(matrix, local_matrix) if matrix is not None else local_matrix
            world_matrices[item] = matrix
        return world_matrices[index]

    for node_index, node in enumerate(nodes):
        local = _node_local_matrix(node)
        parent_index = parents.get(node_index)
        world = world_matrix(node_index)
        mesh_index = node.get("mesh")
        mesh = meshes[mesh_index] if isinstance(mesh_index, int) and mesh_index < len(meshes) else None
        world_bounds = []
        if mesh:
            for primitive in mesh["primitives"]:
                bounds = primitive.get("bounds")
                if bounds:
                    minimum, maximum = bounds["min"], bounds["max"]
                    corners = [
                        [x, y, z]
                        for x in (minimum[0], maximum[0])
                        for y in (minimum[1], maximum[1])
                        for z in (minimum[2], maximum[2])
                    ]
                    world_bounds.extend(_transform_point(world, point) for point in corners)
        bounding_box = None
        if world_bounds:
            bounding_box = {
                "min": [min(point[axis] for point in world_bounds) for axis in range(3)],
                "max": [max(point[axis] for point in world_bounds) for axis in range(3)],
            }
            bounding_box["dimensions"] = [
                bounding_box["max"][axis] - bounding_box["min"][axis]
                for axis in range(3)
            ]
        parsed_nodes.append(
            {
                "source_id": f"node:{node_index}",
                "node_index": node_index,
                "source_model_id": source_model_id,
                "name": node.get("name"),
                "parent_node_index": parent_index,
                "child_node_indices": node.get("children", []),
                "mesh_index": mesh_index,
                "local_transform": local,
                "world_transform": world,
                "bounding_box": bounding_box,
                "geometry_reference": (
                    {"mesh_index": mesh_index, "primitives": mesh["primitives"]}
                    if mesh
                    else None
                ),
                "metadata": node.get("extras", {}),
                "extensions": node.get("extensions", {}),
            }
        )
    ai_nodes = []
    for node in parsed_nodes[:MAX_AI_ITEMS]:
        mesh = meshes[node["mesh_index"]] if isinstance(node["mesh_index"], int) and 0 <= node["mesh_index"] < len(meshes) else None
        ai_nodes.append(
            {
                key: node[key]
                for key in (
                    "source_id",
                    "node_index",
                    "name",
                    "parent_node_index",
                    "child_node_indices",
                    "mesh_index",
                    "local_transform",
                    "world_transform",
                    "bounding_box",
                    "metadata",
                    "extensions",
                )
            }
            | {
                "mesh_summary": [
                    {
                        "primitive_index": primitive["primitive_index"],
                        "mode": primitive["mode"],
                        "vertex_count": primitive["vertex_count"],
                        "index_data": {
                            "accessor_index": primitive["index_data"]["accessor_index"],
                            "count": primitive["index_data"]["count"],
                        } if primitive["index_data"] else None,
                        "bounds": primitive["bounds"],
                        "material_index": primitive["material_index"],
                    }
                    for primitive in mesh["primitives"]
                ] if mesh else []
            }
        )
    groups = _branch_groups(parsed_nodes, meshes)
    content = "\n".join(
        ["MODEL BRANCHES (assemblies with aggregated world bounds; interpret a branch as one logical object when its "
         "children are its parts, and cite group:node:N for it):"]
        + [json.dumps(group, ensure_ascii=False, separators=(",", ":")) for group in groups[:MAX_AI_ITEMS]]
        + ["NODES:"]
        + [json.dumps(node, ensure_ascii=False, separators=(",", ":")) for node in ai_nodes]
    )
    return ParsedSource(
        source_type="cad",
        extraction_method="gltf_json",
        content=content,
        evidence=[
            {
                "source_id": node["source_id"],
                "text": json.dumps(node, ensure_ascii=False, separators=(",", ":")),
            }
            for node in parsed_nodes
        ] + [
            {"source_id": group["source_id"], "text": json.dumps(group, ensure_ascii=False, separators=(",", ":"))}
            for group in groups
        ],
        parsed_data={
            "format": suffix[1:],
            "asset": document.get("asset", {}),
            "scene": document.get("scene"),
            "scenes": document.get("scenes", []),
            "nodes": parsed_nodes,
            "meshes": meshes,
            "materials": document.get("materials", []),
            "extensions_used": document.get("extensionsUsed", []),
            "extensions_required": document.get("extensionsRequired", []),
            "external_buffer_names": [
                PurePosixPath(urlsplit(buffer.get("uri", "")).path).name
                for buffer in document.get("buffers", [])
                if isinstance(buffer, dict) and buffer.get("uri") and not buffer["uri"].startswith("data:")
            ],
            "ai_interpretation_truncated": len(parsed_nodes) > MAX_AI_ITEMS,
            "groups": groups,
        },
    )
