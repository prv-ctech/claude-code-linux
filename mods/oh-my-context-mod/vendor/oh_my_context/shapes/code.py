"""code (Python only): function bodies become `...`."""
import ast


def compress(text: str):
    tree = ast.parse(text)
    lines = text.split("\n")
    spans = []

    def visit(node):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
                body = ch.body
                if (isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    body = body[1:]
                if body:
                    first = lines[body[0].lineno - 1]
                    pre = first.encode()[:body[0].col_offset].decode()
                    if not pre.strip():  # skip bodies sharing the def line
                        spans.append((body[0].lineno, ch.end_lineno, pre))
            else:
                visit(ch)

    visit(tree)
    if not spans:
        return None
    for start, end, pre in sorted(spans, reverse=True):
        lines[start - 1:end] = [pre + "..."]
    out = "\n".join(lines)
    ast.parse(out)
    return out
