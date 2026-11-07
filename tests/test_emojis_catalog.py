import re
import unittest

from core.support import emojis

PORTAL = {
    "game": "1564624331663745034", "book": "1564624329889681418",
    "skip_left": "1564624328224538756", "gear": "1564624326509203557",
    "skip_right": "1564624324508262500", "restart": "1563559489121030184",
    "reset": "1563559487351160972", "shuffle": "1563559485170122802",
    "clock": "1563559483257655306", "y_": "1563559481768411257",
    "loupe": "1563559480069853245", "thu": "1563559478220038175",
    "vol": "1563559476265488414", "b_": "1563559473422016512",
    "g_": "1563559471048032376", "AGO_TICKET": "1562021130259275778",
    "music": "1561710964238450809", "dice": "1561710962208280690",
    "crock": "1561710960387956757", "Back": "1561700549236097034",
    "Pause": "1561700510447312916", "Left": "1561698207757500537",
    "Right": "1561698129655373845", "thinking": "1561695212814995596",
    "PREMIUM_AGO_TICKET": "1559334882809872474",
    "AGO_COIN": "1510157386361475082", "IMG_2977": "1491033617667985490",
    "bakuhatu": "1491033612114591927", "hage": "1491033609929490492",
    "failed": "1490986584676368535", "success": "1490985168100659322",
    "URANAI": "1490255412837093568", "KYOJIN": "1490254596642439259",
    "REIBAI": "1490254594809266297", "KISHI": "1490254592800456794",
    "MASAI": "1490254590757572758", "nyurou": "1490254586575851621",
    "MENHERA": "1490254584739008522", "NYUROU": "1490254582977134672",
    "JINROU": "1490254581358264382", "AGOMUNI": "1490254579336613898",
    "PANYA": "1490254577558093944",
}
PORTAL_ANIMATED = {
    "POYOPOYO": "1490724627805110392", "BAKUHATU": "1490259644717993995",
    "AGOMUNIMUNI": "1490255555632037909",
}


class EmojisCatalogTest(unittest.TestCase):
    def test_all_portal_emojis_defined(self):
        values = [v for v in vars(emojis).values() if isinstance(v, str)]
        joined = "\n".join(values)
        for name, emoji_id in PORTAL.items():
            self.assertIn(f"<:{name}:{emoji_id}>", joined, name)
        for name, emoji_id in PORTAL_ANIMATED.items():
            self.assertIn(f"<a:{name}:{emoji_id}>", joined, name)

    def test_existing_constants_unchanged(self):
        self.assertEqual(emojis.SUCCESS, "<:success:1490985168100659322>")
        self.assertEqual(emojis.FAILED, "<:failed:1490986584676368535>")
        self.assertEqual(emojis.COIN, "<:AGO_COIN:1510157386361475082>")
        self.assertEqual(emojis.TICKET, "<:PREMIUM_AGO_TICKET:1559334882809872474>")
        self.assertEqual(emojis.LOADING, "<a:POYOPOYO:1490724627805110392>")
        self.assertEqual(emojis.CROCK, "<:crock:1561710960387956757>")
        self.assertEqual(emojis.BACK, "<:Back:1561700549236097034>")
        self.assertEqual(emojis.MUSIC, "<:music:1561710964238450809>")

    def test_constant_format(self):
        pat = re.compile(r"^<a?:[A-Za-z0-9_]+:[0-9]+>$")
        for name, value in vars(emojis).items():
            if name.startswith("_") or not isinstance(value, str):
                continue
            self.assertRegex(value, pat, name)


if __name__ == "__main__":
    unittest.main()
