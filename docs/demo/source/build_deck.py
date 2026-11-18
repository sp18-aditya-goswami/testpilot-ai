"""Builds docs/demo/TestPilot-AI-demo.pptx, the 9-slide demo deck in look A.

Run from the repo root with the project venv (python-pptx is installed there, not in requirements.txt):

    .venv/bin/python docs/demo/source/build_deck.py

Layout is designed on a 1920 x 1080 px canvas with 128 px margins and converted to EMU; 1 px = 0.5 pt.
The font is Arial so the deck renders the same on every machine (Geologica, the app's font, cannot be embedded).
"""

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "TestPilot-AI-demo.pptx"

PX = 6350  # EMU per px on a 1920-wide, 13.333-inch slide
FONT = "Arial"

PAPER = RGBColor(0x0B, 0x11, 0x16)
PANEL = RGBColor(0x12, 0x1A, 0x20)
RULE = RGBColor(0x25, 0x30, 0x38)
INK = RGBColor(0xEE, 0xF2, 0xF4)
INK2 = RGBColor(0xC4, 0xCC, 0xD1)
MUTED = RGBColor(0x94, 0xA0, 0xA8)
ACCENT = RGBColor(0xC6, 0xF1, 0x5C)
ACCENT_INK = RGBColor(0x18, 0x24, 0x0A)


def px(v: float) -> Emu:
    return Emu(int(round(v * PX)))


def background(slide, color=PAPER):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def rect(slide, x, y, w, h, fill, line=None, radius=None):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE, px(x), px(y), px(w), px(h))
    if radius:
        shape.adjustments[0] = radius / min(w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(1)
    shape.shadow.inherit = False
    return shape


def text(slide, x, y, w, h, runs, size, color=INK, bold=False, align=PP_ALIGN.LEFT, line=1.15, anchor=MSO_ANCHOR.TOP, gap=0, bullets=False):
    """runs: a string, or a list of paragraphs; a paragraph is a string or a list of (text, color, bold) runs."""
    box = slide.shapes.add_textbox(px(x), px(y), px(w), px(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.auto_size = None
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = anchor
    paragraphs = runs if isinstance(runs, list) else [runs]
    for i, para in enumerate(paragraphs):
        p = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        p.alignment = align
        p.line_spacing = line
        if gap and i < len(paragraphs) - 1:
            p.space_after = Pt(gap / 2)
        if bullets:  # a real bullet with a hanging indent, so wrapped lines align with the text
            pPr = p._p.get_or_add_pPr()
            pPr.set("marL", str(px(40)))
            pPr.set("indent", str(-px(40)))
            for tag in ("a:buNone", "a:buChar", "a:buAutoNum"):
                for old in pPr.findall(qn(tag)):
                    pPr.remove(old)
            bu = pPr.makeelement(qn("a:buChar"), {"char": "•"})
            pPr.append(bu)
        parts = para if isinstance(para, list) else [(para, color, bold)]
        for content, c, b in parts:
            r = p.add_run()
            r.text = content
            r.font.name = FONT
            r.font.size = Pt(size / 2)
            r.font.bold = b
            r.font.color.rgb = c
    return box


def notes(slide, words):
    slide.notes_slide.notes_text_frame.text = words


def heading(slide, words, color=INK):
    text(slide, 128, 128, 1664, 80, words, 64, color=color, bold=True)


def card(slide, x, y, w, h, title, body, title_color=INK, body_size=28):
    rect(slide, x, y, w, h, PANEL, line=RULE, radius=16)
    text(slide, x + 44, y + 44, w - 88, 56, title, 40, color=title_color, bold=True)
    text(slide, x + 44, y + 118, w - 88, h - 150, body, body_size, color=INK2, line=1.3)


def build() -> None:
    prs = Presentation()
    prs.slide_width = px(1920)
    prs.slide_height = px(1080)
    blank = prs.slide_layouts[6]

    # 1. Title
    s = prs.slides.add_slide(blank)
    background(s)
    text(s, 128, 330, 1664, 140, "TestPilot AI", 120, bold=True, line=1.0)
    rect(s, 128, 492, 120, 8, ACCENT)
    text(s, 128, 540, 1664, 70, "Test an API without writing the tests.", 56, line=1.1)
    text(s, 128, 628, 1664, 46, "AI plans the tests. Code runs them and decides pass or fail.", 32, color=MUTED)
    text(s, 128, 986, 1000, 30, "Python Mirai Squad", 24, color=MUTED)
    notes(s, "TestPilot AI turns an OpenAPI spec and our business rules into a reviewed, runnable test plan. The AI plans; code runs and judges.")

    # 2. The problem
    s = prs.slides.add_slide(blank)
    background(s)
    heading(s, "Writing API tests today")
    w3 = (1664 - 2 * 40) / 3
    problems = [
        ("Slow to write", "Every endpoint needs its own Postman scripts or pytest cases, written by hand, every day."),
        ("Rules get missed", "Schema checks pass, but rules like “email must be unique” go untested until a bug reaches staging."),
        ("AI chat is manual", "Claude, ChatGPT and other LLMs can draft tests, but it is prompting and copy-paste: no flow, no record, no reliable pass or fail."),
    ]
    for i, (t, b) in enumerate(problems):
        card(s, 128 + i * (w3 + 40), 300, w3, 420, t, b, body_size=32)
    notes(s, "Three pains: writing tests by hand is slow; business rules are what get missed; and AI chat tools help, but without a flow or a trustworthy verdict.")

    # 3. What TestPilot AI does
    s = prs.slides.add_slide(blank)
    background(s)
    heading(s, "What TestPilot AI does")
    pillars = [
        ("AI plans", "Test cases from your OpenAPI spec, your business rules and what you want to focus on."),
        ("Code judges", "Code sends every request and checks status, schema and time. The AI never decides pass or fail."),
        ("You get a fix", "A readable report of what to fix, with the likely cause and a suggested fix."),
    ]
    for i, (t, b) in enumerate(pillars):
        x = 128 + i * (w3 + 40)
        rect(s, x, 360, 80, 8, ACCENT)
        text(s, x, 410, w3, 80, t, 64, bold=True)
        text(s, x, 520, w3 - 20, 300, b, 36, color=INK2, line=1.3)
    notes(s, "The split matters: the AI is good at planning and explaining, code is good at judging. Pass or fail is always decided by code.")

    # 4. How it works
    s = prs.slides.add_slide(blank)
    background(s)
    heading(s, "How it works")
    s.shapes.add_picture(str(HERE / "flow.png"), px(128), px(240), width=px(1560))
    text(s, 128, 900, 1664, 46, [[("AI plans and explains. ", ACCENT, True), ("Code runs and judges.", INK, False)]], 32)
    notes(s, "Four steps on top, what TestPilot does underneath. Amber boxes are the AI, green boxes are code. Next: the live demo.")

    # 5. Live demo (accent statement slide)
    s = prs.slides.add_slide(blank)
    background(s, ACCENT)
    text(s, 128, 128, 1664, 120, "Live demo", 104, color=ACCENT_INK, bold=True, line=1.0)
    text(s, 128, 270, 1664, 50, "On the User Management API, a sample API with planted bugs.", 36, color=ACCENT_INK)
    steps = [
        "Read the spec: TestPilot finds sign-up and login, so it signs itself in.",
        "Pick the focus and business rules, then build the AI plan.",
        "Review the cases, then run them, with a second user.",
        "Read what to fix, and open Show fix.",
    ]
    for i, line in enumerate(steps):
        y = 420 + i * 112
        rect(s, 128, y, 64, 64, ACCENT_INK, radius=32)
        text(s, 128, y, 64, 64, str(i + 1), 32, color=ACCENT, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(s, 224, y, 1560, 64, line, 36, color=ACCENT_INK, anchor=MSO_ANCHOR.MIDDLE)
    notes(s, "Switch to the app. Spec: http://localhost:8008/openapi.json, server: http://localhost:8008. Tick Auth and permissions to turn on the second user.")

    # 6. What you just saw
    s = prs.slides.add_slide(blank)
    background(s)
    heading(s, "What you just saw")
    w2 = (1664 - 40) / 2
    seen = [
        ("Signs itself in", "Finds sign-up and login in the spec and gets its own token. Asks only when it cannot."),
        ("Tests with two users", "User B tries to read or change user A’s data. Any success is a finding."),
        ("Shows who made each case", "AI, Schema, Fuzzing or Written by you, with the reason for every case."),
        ("Explains and suggests fixes", "Each failure gets a likely cause. Show fix adds steps and a code sketch."),
    ]
    for i, (t, b) in enumerate(seen):
        card(s, 128 + (i % 2) * (w2 + 40), 270 + (i // 2) * 290, w2, 260, t, b)
    text(s, 128, 870, 1664, 46, "Works with several AI providers.", 32, color=MUTED)
    notes(s, "Recap of the demo. Provider: TestPilot works with the Anthropic API, OpenAI and models on AWS Bedrock; the app itself only says AI.")

    # 7. Architecture
    s = prs.slides.add_slide(blank)
    background(s)
    heading(s, "Architecture")
    s.shapes.add_picture(str(HERE / "architecture.png"), px(128), px(230), width=px(1580))
    text(
        s, 128, 906, 1664, 40,
        [[("Stack: ", INK, True), ("Next.js 15, React 19, TypeScript, Python, FastAPI, Pydantic, SQLite, Schemathesis", INK2, False)]],
        28,
    )
    notes(s, "Planning and runs are background tasks in the FastAPI process. The AI gateway is one function that returns checked JSON from whichever provider is set. Requests go only to allowed hosts; tokens are hidden in reports.")

    # 8. Limits and roadmap
    s = prs.slides.add_slide(blank)
    background(s)
    heading(s, "Limits today, and what is next")
    limits = ["Login with cookies is not supported yet.", "Fuzzing requests go without the sign-in token."]
    nxt = [
        "What changed since the last run: new, fixed, still failing.",
        "Export tests as code: pytest and Postman.",
        "Run on every pull request and block failing merges.",
        "Nightly checks with Slack or email alerts.",
        "One-click Jira or GitHub issues from a failure.",
        "Re-run only the cases that failed.",
        "Team accounts with admin, tester and viewer roles.",
    ]
    cards = [("Limits today", limits, INK, 128, 560), ("Next", nxt, ACCENT, 128 + 560 + 40, 1664 - 560 - 40)]
    for t, items, color, x, w in cards:
        rect(s, x, 270, w, 600, PANEL, line=RULE, radius=16)
        text(s, x + 44, 314, w - 88, 56, t, 40, color=color, bold=True)
        text(s, x + 44, 396, w - 88, 440, items, 28, color=INK2, line=1.2, gap=18, bullets=True)
    notes(s, "Honest limits so there are no surprises. Roadmap items are not built yet.")

    # 9. Questions
    s = prs.slides.add_slide(blank)
    background(s)
    text(s, 128, 360, 1664, 140, "Questions?", 120, bold=True, line=1.0)
    rect(s, 128, 522, 120, 8, ACCENT)
    text(s, 128, 570, 1664, 70, "Thank you.", 56)
    text(s, 128, 986, 1000, 30, "Python Mirai Squad", 24, color=MUTED)
    notes(s, "Open for questions.")

    prs.save(OUT)
    print(OUT)


if __name__ == "__main__":
    build()
