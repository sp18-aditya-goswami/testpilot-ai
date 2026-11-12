from typing import Any

UNIQUE = "{{unique}}"


def example_for(schema: dict[str, Any] | None, field_name: str = "") -> Any:
    schema = schema or {}
    for key in ("example", "default"):
        if key in schema and schema[key] is not None:
            return schema[key]
    if schema.get("examples"):
        examples = schema["examples"]
        return examples[0] if isinstance(examples, list) else next(iter(examples.values()), None)
    if schema.get("enum"):
        return schema["enum"][0]
    if "const" in schema:
        return schema["const"]

    for combo in ("anyOf", "oneOf", "allOf"):
        options = [s for s in schema.get(combo, []) if s.get("type") != "null"]
        if options:
            if combo == "allOf":
                merged: dict[str, Any] = {"type": "object", "properties": {}, "required": []}
                for part in options:
                    merged["properties"].update(part.get("properties", {}))
                    merged["required"] += part.get("required", [])
                return example_for(merged, field_name)
            return example_for(options[0], field_name)

    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), None)
    fmt = schema.get("format", "")
    lname = field_name.lower()

    if kind == "object" or "properties" in schema:
        return {name: example_for(sub, name) for name, sub in schema.get("properties", {}).items()}
    if kind == "array":
        return [example_for(schema.get("items"), field_name)]
    if kind == "integer":
        return int(schema.get("minimum", 1))
    if kind == "number":
        return float(schema.get("minimum", 1.5))
    if kind == "boolean":
        return True
    if kind == "string" or kind is None:
        if fmt == "email" or "email" in lname:
            return f"tp.{UNIQUE}@example.com"
        if fmt == "date-time":
            return "2026-01-15T10:00:00Z"
        if fmt == "date":
            return "2026-01-15"
        if fmt == "uuid":
            return "3fa85f64-5717-4562-b3fc-2c963f66afa6"
        if fmt in ("uri", "url"):
            return "https://example.com"
        if "password" in lname:
            value = "Str0ngPass!42"
        elif "name" in lname:
            value = "Test User"
        else:
            value = "sample"
        min_len = schema.get("minLength", 0)
        max_len = schema.get("maxLength")
        if len(value) < min_len:
            value = value + "x" * (min_len - len(value))
        if max_len is not None:
            value = value[:max_len]
        return value
    return None


def primary_schema(schema: dict[str, Any] | None) -> dict[str, Any]:
    schema = schema or {}
    for combo in ("anyOf", "oneOf"):
        options = [s for s in schema.get(combo, []) if s.get("type") != "null"]
        if options:
            return options[0]
    return schema


def wrong_type_value(schema: dict[str, Any] | None) -> Any:
    kind = primary_schema(schema).get("type")
    if kind in ("integer", "number"):
        return "not-a-number"
    if kind == "boolean":
        return "not-a-boolean"
    if kind == "array":
        return {"unexpected": "object"}
    if kind == "object":
        return ["unexpected", "list"]
    return 12345
