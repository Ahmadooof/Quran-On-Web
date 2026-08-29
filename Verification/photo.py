"""
A photograph of a printed page, turned into ink the model can read.

Only what the model needs: the picture the right way up, cropped to the printed
frame and straightened, then thresholded. Everything the old pipeline did after
that -- finding lines, registering them against the type, comparing words --
is left out. This is here to answer one question, which is what a net trained
on a font makes of a photograph of a press.

The DNG path and the crop were measured earlier: flash beats no flash (62% of
faults found against 43%), 50 MP beats a 0.6 MB scan by nothing at all, and
three of four raw captures found the wrong number of lines until the frame was
detected and the page straightened by it.
"""

import numpy as np
import cv2


def _raw(path):
    """A DNG as an 8-bit BGR image.

    Phone "expert" modes write DNG 1.7 with JPEG XL compression, which LibRaw
    and OpenCV both refuse; tifffile with imagecodecs reads it. What comes out
    is linear -- scene light, not display values -- so it has to be given a
    gamma before it looks like a photograph or thresholds like one. The white
    point is taken from a high percentile rather than the maximum, so one hot
    pixel cannot darken the whole page.
    """
    import tifffile
    with tifffile.TiffFile(path) as tf:
        page = max(tf.pages, key=lambda p: int(np.prod(p.shape[:2])))
        a = page.asarray()
        tag = page.tags.get("Orientation")
        turn = int(tag.value) if tag is not None else 1
    # The camera records which way up it was held instead of rotating the
    # pixels, exactly as it does in a JPEG's EXIF -- and a page read sideways
    # finds three lines instead of fifteen.
    a = {1: lambda x: x,
         3: lambda x: x[::-1, ::-1],
         6: lambda x: np.rot90(x, -1),
         8: lambda x: np.rot90(x, 1)}.get(turn, lambda x: x)(a)
    a = a.astype(np.float32)
    if a.ndim == 2:
        a = np.dstack([a] * 3)
    hi = np.percentile(a, 99.7)
    a = np.clip(a / (hi if hi > 0 else 1.0), 0, 1) ** (1 / 2.2)
    return (a[:, :, ::-1] * 255).astype(np.uint8)


def load(path, longest=2600):
    """Read a photograph the right way up, at a workable size.

    Phone cameras record the orientation in EXIF rather than rotating the
    pixels, and OpenCV's IMREAD_UNCHANGED ignores it -- so a 50 MP portrait
    page arrives on its side and nothing downstream makes sense. Pillow is
    asked to apply the tag instead.

    Also scaled down. Resolution was measured not to matter here (764 px and
    1529 px across the page found the same share of lost marks), and a 50 MP
    frame costs minutes per page for nothing.
    """
    from PIL import Image, ImageOps
    if str(path).lower().endswith((".dng", ".tif", ".tiff")):
        a = _raw(path)
        if longest and max(a.shape[:2]) > longest:
            s = longest / max(a.shape[:2])
            a = cv2.resize(a, (int(a.shape[1] * s), int(a.shape[0] * s)),
                           interpolation=cv2.INTER_AREA)
        return page_crop(a)
    im = ImageOps.exif_transpose(Image.open(path))
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    if longest and max(im.size) > longest:
        s = longest / max(im.size)
        im = im.resize((max(1, int(im.size[0] * s)), max(1, int(im.size[1] * s))),
                       Image.LANCZOS)
    a = np.array(im)
    a = a[:, :, ::-1].copy() if a.ndim == 3 else a         # PIL is RGB, cv2 is BGR
    return page_crop(a)


def page_crop(img, margin=0.012):
    """Cut the photograph down to the printed frame, straightening it.

    A photograph straight off a phone carries the desk, the facing page and
    whatever shadow falls across them, and the horizontal projection counts all
    of it as lines: three of four test captures came out with 16 or 19 bands
    instead of 15. A page cropped by a scanning app never showed the problem,
    which is why it went unnoticed.

    The mushaf prints a coloured frame around its text, and colour is the one
    thing on the sheet the surroundings do not have. Its outline gives both the
    crop and the rotation, so a page photographed a few degrees off square is
    put straight here rather than being carried as error into every line.

    The frame itself is left in. Only its blue is saturated enough to drop by
    colour, so its silver tracery survives thresholding and looks like a band
    of noise down both sides -- but cutting inward to the white gutter to get
    rid of it broke the line detection on five captures out of six, taking a
    text line off the foot of the page, while removing it changed no score:
    each line is registered to a window inside the measure, so the frame is
    already outside everything that gets compared. It is ugly and harmless.

    Returns the image unchanged when no frame is found -- an already-cropped
    scan, or a mushaf printed without one.
    """
    if img.ndim != 3:
        return img
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    colour = ((hsv[:, :, 1] > 70) & (hsv[:, :, 2] > 80)).astype(np.uint8)
    if colour.sum() < img.shape[0] * img.shape[1] * 0.002:
        return img
    k = max(3, int(min(img.shape[:2]) * 0.01)) | 1
    closed = cv2.morphologyEx(colour, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(closed, 8)
    if n < 2:
        return img
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    pts = cv2.findNonZero((lab == i).astype(np.uint8))
    (cx, cy), (w, h), ang = cv2.minAreaRect(pts)
    if w < img.shape[1] * 0.3 or h < img.shape[0] * 0.3:
        return img
    if ang < -45:
        ang += 90
        w, h = h, w
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    straight = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]),
                              flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    pad_x, pad_y = w * margin, h * margin
    x0 = int(max(0, cx - w / 2 + pad_x))
    x1 = int(min(img.shape[1], cx + w / 2 - pad_x))
    y0 = int(max(0, cy - h / 2 + pad_y))
    y1 = int(min(img.shape[0], cy + h / 2 - pad_y))
    if x1 - x0 < 50 or y1 - y0 < 50:
        return img
    return straight[y0:y1, x0:x1]


def grey(img):
    """The page as evened-out greys, never thresholded.

    Binarising is a decision, and it is taken at the worst possible moment --
    before anything has looked at the mark. A faint tashkeel on old paper sits
    a few levels above the page, and a threshold either keeps it or destroys
    it with no way back. The geometry still runs on the ink mask, because
    projections and components need one; what gets compared can be this.
    """
    if img.ndim == 3 and img.shape[2] == 4:
        a = (img[:, :, 3] / 255.0)[..., None]
        img = (img[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)


def ink(img, despeckle=True):
    """Ink mask for a photograph: even out the lighting, drop a colour border.

    `despeckle` runs a 3px median, which clears ten thousand specks off a phone
    photograph -- and takes a couple of hundred blobs of tashkeel size with
    them. Whether that trade is worth making is measured, not assumed.
    """
    if img.ndim == 3 and img.shape[2] == 4:
        a = (img[:, :, 3] / 255.0)[..., None]
        img = (img[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    colour = None
    if img.ndim == 3:
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        colour = (hsv[:, :, 1] > 80) & (hsv[:, :, 2] > 90)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(img)
    # 81/20 rather than 51/15: swept against page 3, a wider window reads the
    # thin marks slightly better (60% of lost marks found against 58%). A
    # global Otsu is clearly worse at 53% -- a photographed page is never lit
    # evenly enough for one threshold.
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY_INV, 81, 20)
    if colour is not None:
        bw[colour] = 0          # the illuminated border, not the text
    return cv2.medianBlur(bw, 3) if despeckle else bw
