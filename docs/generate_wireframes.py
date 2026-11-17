from html import escape
from pathlib import Path


OUT = Path(__file__).with_name("enrollment-wireframes-figma.svg")
W, H = 2400, 2220
INK = "#342d2a"
SOFT = "#6c615b"
PAPER = "#fbf9f4"
FONT = "Segoe Print, Comic Sans MS, cursive"
parts = []


def add(s):
    parts.append(s)


def txt(x, y, value, size=14, weight=500, color=INK):
    add(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(value)}</text>')


def line(x1, y1, x2, y2, width=2):
    # A tiny bend keeps strokes from looking like perfectly typeset UI lines.
    midx, midy = (x1 + x2) / 2, (y1 + y2) / 2 - 1.3
    add(f'<path d="M{x1},{y1} Q{midx},{midy} {x2},{y2}" fill="none" stroke="{INK}" stroke-width="{width}" stroke-linecap="round"/>')


def box(x, y, w, h, radius=8, width=2, fill="none"):
    add(f'<path d="M{x+radius},{y+1} Q{x-1},{y-1} {x+1},{y+radius} L{x},{y+h-radius} Q{x+1},{y+h+2} {x+radius},{y+h} L{x+w-radius},{y+h-1} Q{x+w+2},{y+h} {x+w},{y+h-radius} L{x+w-1},{y+radius} Q{x+w+1},{y} {x+w-radius},{y+1} Z" fill="{fill}" stroke="{INK}" stroke-width="{width}" stroke-linejoin="round"/>')


def xbox(x, y, w, h, label="VIDEO / IMAGE"):
    box(x, y, w, h, radius=7, width=2)
    add(f'<path d="M{x+4},{y+5} Q{x+w*.48},{y+h*.45} {x+w-4},{y+h-5} M{x+w-5},{y+5} Q{x+w*.5},{y+h*.5} {x+5},{y+h-5}" fill="none" stroke="{INK}" stroke-width="2" stroke-linecap="round"/>')
    txt(x+10, y+h-10, label, 10, 600, SOFT)


def button(x, y, w, label, h=34):
    box(x, y, w, h, radius=8, width=2)
    txt(x+12, y+h*.67, label, 13, 600)


def field(x, y, w, label, placeholder="write here"):
    txt(x, y, label, 12, 600)
    box(x, y+7, w, 31, radius=5, width=1.7)
    txt(x+10, y+28, placeholder, 11, 400, SOFT)


def checkrow(x, y, label, checked=False):
    box(x, y-15, 18, 18, radius=3, width=1.8)
    if checked:
        add(f'<path d="M{x+3},{y-6} l5,5 l9,-12" fill="none" stroke="{INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')
    txt(x+27, y, label, 12, 500)


def phone_shell():
    # Drawn handset frame and a loose status bar, like a paper sketch.
    box(76, 55, 270, 385, radius=27, width=3, fill="#fffefa")
    line(166, 69, 254, 69, 2)
    txt(91, 84, "9:41", 9, 600)
    txt(294, 84, "•••", 10, 600)
    line(90, 94, 332, 94, 1.5)
    return 94


def phone_title(title, y=122):
    txt(98, y, title, 17, 700)
    line(98, y+8, 314, y+10, 1.5)


def desktop_shell():
    box(30, 58, 462, 340, radius=12, width=3, fill="#fffefa")
    line(42, 93, 480, 92, 1.8)
    txt(46, 82, "school enrollment", 11, 600)
    txt(426, 82, "•••", 10, 600)
    return 105


def draw_screen(sid, title, kind, body):
    col = len(screens) % 4
    row = len(screens) // 4
    ox, oy = 45 + col*585, 160 + row*515
    add(f'<g id="{sid}" data-name="{escape(sid + " " + title)}" transform="translate({ox},{oy})">')
    txt(28, 30, sid, 14, 700)
    txt(80, 31, title, 19, 700)
    line(28, 42, 515, 43, 1.6)
    if kind == "phone":
        phone_shell()
    else:
        desktop_shell()
    body()
    add("</g>")
    screens.append(sid)


screens = []


def u01():
    phone_title("Before your ticket")
    txt(98, 145, "Finish these first", 12)
    checkrow(101, 184, "Documents checked", True)
    checkrow(101, 220, "Orientation watched", False)
    xbox(101, 246, 214, 91, "ORIENTATION VIDEO")
    button(101, 355, 214, "Continue", 36)


def u02():
    phone_title("Choose your grade")
    txt(98, 151, "Which grade are you entering?", 12)
    box(101, 177, 213, 59, radius=9, width=2)
    txt(116, 202, "Grade 11", 15, 600)
    txt(116, 222, "New senior high student", 10, 400, SOFT)
    box(101, 249, 213, 59, radius=9, width=2)
    txt(116, 274, "Grade 12", 15, 600)
    txt(116, 294, "Returning student", 10, 400, SOFT)
    button(101, 339, 214, "Next")


def u03():
    phone_title("Choose a track family")
    txt(98, 151, "Select a pathway", 12)
    for i, v in enumerate(["Academic", "TVL", "Arts & Design", "Sports"]):
        y = 170 + i*43
        box(101, y, 213, 35, radius=7, width=1.8)
        txt(115, y+23, v, 13, 600)
        txt(288, y+23, "○", 15, 500)
    button(101, 354, 214, "Next")


def u04():
    phone_title("Pick a track")
    txt(98, 151, "Choose your preferred track", 12)
    for i, v in enumerate(["STEM", "ABM", "HUMSS", "GAS"]):
        y = 170 + i*43
        box(101, y, 213, 35, radius=7, width=1.8)
        txt(115, y+23, v, 13, 600)
        txt(288, y+23, "○", 15, 500)
    button(101, 354, 214, "Next")


def u05():
    phone_title("Review your details")
    for y, label, value in [(161, "Grade", "Grade 11"), (212, "Pathway", "Academic"), (263, "Track", "STEM")]:
        txt(101, y, label, 11, 600, SOFT)
        box(101, y+6, 213, 30, radius=4, width=1.5)
        txt(110, y+27, value, 12, 500)
    checkrow(101, 332, "Details are correct", True)
    button(101, 358, 214, "Get my ticket", 34)


def u06():
    phone_title("Your ticket")
    txt(100, 160, "A - 014", 32, 700)
    line(100, 170, 312, 168, 2.2)
    txt(101, 195, "WAITING FOR TEACHER", 11, 700)
    box(101, 207, 213, 42, radius=6, width=1.8)
    txt(113, 232, "Step 1 · Teacher meeting", 12, 600)
    txt(101, 276, "Requirements", 12, 600)
    checkrow(103, 301, "Documents", True)
    checkrow(103, 330, "Orientation", True)
    checkrow(103, 359, "Brigada", False)
    txt(101, 404, "Wait here until your number is called", 10, 500, SOFT)


def u07():
    phone_title("Ticket desk closed")
    xbox(135, 154, 147, 100, "CLOSED")
    txt(106, 285, "Ticket requests are paused", 13, 600)
    txt(106, 307, "Please check with school staff.", 11, 400, SOFT)
    button(101, 350, 214, "Try again later")


def u08():
    phone_title("Now serving")
    txt(101, 160, "PLEASE GO TO", 11, 700)
    txt(101, 214, "A - 014", 37, 700)
    line(100, 223, 314, 220, 2.5)
    box(101, 247, 214, 63, radius=8, width=2)
    txt(116, 273, "Teacher station", 14, 600)
    txt(116, 295, "Room 3", 12, 500)
    txt(101, 344, "Please come forward", 12, 500)


def u09():
    phone_title("Queue display")
    xbox(140, 155, 138, 95, "SCHOOL LOGO")
    txt(107, 290, "No ticket is being called", 13, 600)
    txt(107, 315, "Please wait for your number", 11, 400, SOFT)
    line(109, 343, 309, 344, 1.5)
    txt(111, 367, "Staff will call the next student", 10, 400, SOFT)


def s01():
    x = desktop_shell()
    xbox(202, 120, 123, 57, "SCHOOL MARK")
    txt(112, 199, "Staff sign in", 18, 700)
    field(112, 222, 295, "Email", "name@school.edu")
    field(112, 278, 295, "Password", "••••••••")
    button(112, 344, 295, "Sign in", 35)
    txt(112, 391, "Forgot password?  Request setup link", 10, 500, SOFT)


def s02():
    x = desktop_shell()
    txt(47, 122, "Queue dashboard", 17, 700)
    box(46, 139, 137, 91, radius=6, width=1.8)
    txt(57, 161, "NOW SERVING", 9, 700)
    txt(57, 199, "A - 014", 21, 700)
    box(196, 139, 137, 91, radius=6, width=1.8)
    txt(207, 161, "WAITING", 9, 700)
    txt(207, 199, "08", 21, 700)
    box(345, 139, 127, 91, radius=6, width=1.8)
    txt(356, 161, "STEP 1", 9, 700)
    txt(356, 190, "Teacher", 13, 600)
    txt(356, 209, "meeting", 12, 500)
    button(48, 246, 126, "Call next", 35)
    button(183, 246, 132, "Recall", 35)
    button(324, 246, 146, "Complete", 35)
    txt(48, 305, "Next in line", 12, 700)
    for i, t in enumerate(["A-015  ·  Grade 11", "A-016  ·  Grade 12", "A-017  ·  Grade 11"]):
        y = 320+i*23
        line(48, y, 472, y+1, 1)
        txt(57, y+17, t, 10, 500)


def a01():
    x = desktop_shell()
    txt(47, 122, "Admin console", 18, 700)
    for i, (v, n) in enumerate([("WAITING", "08"), ("IN SERVICE", "01"), ("DONE", "23")]):
        xx = 48+i*144
        box(xx, 139, 130, 64, radius=7, width=1.8)
        txt(xx+10, 162, v, 9, 700)
        txt(xx+10, 191, n, 19, 700)
    txt(48, 229, "Enrollment session", 13, 700)
    box(48, 239, 260, 125, radius=6, width=1.7)
    txt(60, 263, "Status: OPEN", 11, 600)
    txt(60, 288, "Ticket requests enabled", 10, 500)
    txt(60, 313, "Updated by staff", 10, 500)
    txt(60, 339, "Recent activity  →", 10, 600)
    box(324, 239, 148, 125, radius=6, width=1.7)
    txt(336, 263, "ACCESS", 10, 700)
    txt(336, 291, "Staff", 12, 500)
    txt(336, 315, "Admin", 12, 500)
    txt(336, 342, "Roles →", 10, 600)


def a02():
    x = desktop_shell()
    txt(47, 122, "Session setup", 18, 700)
    field(48, 149, 424, "Session name", "Enrollment 2026")
    txt(48, 212, "Ticket requests", 12, 700)
    checkrow(50, 242, "Open for students", True)
    txt(48, 275, "Session status", 12, 700)
    button(48, 290, 130, "Pause tickets", 34)
    button(190, 290, 130, "Public screen", 34)
    button(332, 290, 140, "Close session", 34)
    txt(48, 365, "Closing is blocked while a student is being served.", 9, 500, SOFT)


def x01():
    x = desktop_shell()
    xbox(202, 115, 123, 54, "SCHOOL MARK")
    txt(112, 194, "Set your password", 17, 700)
    field(112, 217, 295, "New password", "••••••••")
    field(112, 273, 295, "Confirm password", "••••••••")
    button(112, 338, 295, "Save password", 35)
    txt(112, 388, "If the link expired, ask for a new one", 10, 500, SOFT)


def x02():
    x = desktop_shell()
    xbox(202, 116, 123, 58, "ACCESS")
    txt(119, 205, "Access denied", 18, 700)
    txt(119, 234, "This account does not have", 12, 500)
    txt(119, 254, "the required staff role.", 12, 500)
    button(119, 284, 270, "Return to sign in", 35)
    txt(119, 342, "Ask an administrator for access", 10, 500, SOFT)


def x03():
    x = desktop_shell()
    xbox(202, 120, 123, 58, "QUEUE")
    txt(113, 207, "Connection problem", 17, 700)
    txt(113, 234, "Queue data could not load.", 12, 500)
    txt(113, 255, "Check the internet and retry.", 12, 500)
    button(113, 286, 290, "Try again", 35)
    txt(113, 344, "Status: disconnected", 10, 500, SOFT)


add(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<title>Enrollment Queue — Low-fidelity sketch wireframes</title>
<desc>Hand-drawn, black-line sketch wireframes for student, staff, public display, and admin screens.</desc>
<rect width="100%" height="100%" fill="{PAPER}"/>
<text x="56" y="62" font-family="{FONT}" font-size="16" font-weight="600" fill="{SOFT}">01. ENROLLMENT QUEUE</text>
<text x="56" y="111" font-family="{FONT}" font-size="36" font-weight="700" fill="{INK}">LOW-FIDELITY APP WIREFRAMES</text>
<text x="57" y="142" font-family="{FONT}" font-size="15" fill="{SOFT}">Rough screen layouts · student / parent · staff · administrator · public display</text>
''')

draw_screen("U-01", "Preparation requirements", "phone", u01)
draw_screen("U-02", "Incoming grade", "phone", u02)
draw_screen("U-03", "Track family", "phone", u03)
draw_screen("U-04", "Track selection", "phone", u04)
draw_screen("U-05", "Review and request ticket", "phone", u05)
draw_screen("U-06", "Ticket and progress", "phone", u06)
draw_screen("U-07", "Requests paused / closed", "phone", u07)
draw_screen("U-08", "Now serving display", "phone", u08)
draw_screen("U-09", "Queue clear display", "phone", u09)
draw_screen("S-01", "Staff sign-in", "desktop", s01)
draw_screen("S-02", "Staff queue dashboard", "desktop", s02)
draw_screen("A-01", "Admin console", "desktop", a01)
draw_screen("A-02", "Session setup", "desktop", a02)
draw_screen("X-01", "Password setup", "desktop", x01)
draw_screen("X-02", "Access denied", "desktop", x02)
draw_screen("X-03", "Database connection", "desktop", x03)
add("</svg>")
OUT.write_text("\n".join(parts), encoding="utf-8")
print(f"Wrote {OUT} with {len(screens)} screens on a {W}x{H} sketch board.")
