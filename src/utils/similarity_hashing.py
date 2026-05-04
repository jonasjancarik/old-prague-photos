from collections import deque
from statistics import median

from PIL import Image, ImageFilter

from src.utils.similarity_core import visual_hash


def _corner_background(image: Image.Image) -> tuple[int, int, int]:
    width, height = image.size
    sample_size = max(4, min(width, height) // 10)
    pixels = image.load()
    samples: list[tuple[int, int, int]] = []
    regions = [
        (range(sample_size), range(sample_size)),
        (range(width - sample_size, width), range(sample_size)),
        (range(sample_size), range(height - sample_size, height)),
        (range(width - sample_size, width), range(height - sample_size, height)),
    ]
    for xs, ys in regions:
        for x in xs:
            for y in ys:
                samples.append(pixels[x, y])
    return tuple(int(median([sample[channel] for sample in samples])) for channel in range(3))


def _components(mask: Image.Image) -> list[tuple[int, int, int, int, int, bool]]:
    width, height = mask.size
    pixels = mask.load()
    seen: set[tuple[int, int]] = set()
    components: list[tuple[int, int, int, int, int, bool]] = []
    for y in range(height):
        for x in range(width):
            if pixels[x, y] < 128 or (x, y) in seen:
                continue
            queue: deque[tuple[int, int]] = deque([(x, y)])
            seen.add((x, y))
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            touches_border = False
            while queue:
                current_x, current_y = queue.popleft()
                area += 1
                min_x = min(min_x, current_x)
                max_x = max(max_x, current_x)
                min_y = min(min_y, current_y)
                max_y = max(max_y, current_y)
                if (
                    current_x <= 1
                    or current_y <= 1
                    or current_x >= width - 2
                    or current_y >= height - 2
                ):
                    touches_border = True
                for next_x, next_y in (
                    (current_x + 1, current_y),
                    (current_x - 1, current_y),
                    (current_x, current_y + 1),
                    (current_x, current_y - 1),
                ):
                    if (
                        0 <= next_x < width
                        and 0 <= next_y < height
                        and pixels[next_x, next_y] >= 128
                        and (next_x, next_y) not in seen
                    ):
                        seen.add((next_x, next_y))
                        queue.append((next_x, next_y))
            components.append((area, min_x, min_y, max_x + 1, max_y + 1, touches_border))
    return components


def mounted_photo_crop(image: Image.Image) -> tuple[Image.Image, bool]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    scale = 256 / max(width, height)
    small_width = max(1, round(width * scale))
    small_height = max(1, round(height * scale))
    small = rgb.resize((small_width, small_height), Image.Resampling.LANCZOS)
    background = _corner_background(small)
    pixels = small.load()

    distances: list[int] = []
    for y in range(small_height):
        for x in range(small_width):
            red, green, blue = pixels[x, y]
            distances.append(
                abs(red - background[0])
                + abs(green - background[1])
                + abs(blue - background[2])
            )
    if not distances:
        return rgb, False

    sorted_distances = sorted(distances)
    median_distance = median(sorted_distances)
    q90_distance = sorted_distances[int(len(sorted_distances) * 0.9)]
    threshold = max(35, median_distance + (q90_distance - median_distance) * 0.45)

    mask = Image.new("L", (small_width, small_height), 0)
    mask_pixels = mask.load()
    for y in range(small_height):
        for x in range(small_width):
            red, green, blue = pixels[x, y]
            distance = (
                abs(red - background[0])
                + abs(green - background[1])
                + abs(blue - background[2])
            )
            if distance >= threshold:
                mask_pixels[x, y] = 255

    mask = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(5))
    center_x = small_width / 2
    center_y = small_height / 2
    candidates: list[tuple[float, int, int, int, int, int, int]] = []
    for area, min_x, min_y, max_x, max_y, touches_border in _components(mask):
        if touches_border:
            continue
        width_span = max_x - min_x
        height_span = max_y - min_y
        if (
            area / (small_width * small_height) < 0.005
            or width_span < small_width * 0.08
            or height_span < small_height * 0.08
        ):
            continue
        if min_x <= center_x <= max_x and min_y <= center_y <= max_y:
            center_distance = 0.0
        else:
            center_distance = abs((min_x + max_x) / 2 - center_x) + abs(
                (min_y + max_y) / 2 - center_y
            )
        candidates.append((center_distance, -area, min_x, min_y, max_x, max_y, area))

    if not candidates:
        return rgb, False

    _, _, min_x, min_y, max_x, max_y, _ = sorted(candidates)[0]
    padding = max(2, round(min(small_width, small_height) * 0.02))
    min_x = max(0, min_x - padding)
    min_y = max(0, min_y - padding)
    max_x = min(small_width, max_x + padding)
    max_y = min(small_height, max_y + padding)

    box = (
        max(0, int(min_x / scale)),
        max(0, int(min_y / scale)),
        min(width, int(max_x / scale)),
        min(height, int(max_y / scale)),
    )
    crop_width = box[2] - box[0]
    crop_height = box[3] - box[1]
    crop_area = (crop_width * crop_height) / (width * height)
    if crop_area > 0.75 or crop_area < 0.03:
        return rgb, False
    return rgb.crop(box), True


def hash_image_for_similarity(image: Image.Image, hash_size: int) -> int:
    prepared_image, _ = mounted_photo_crop(image)
    return visual_hash(prepared_image, hash_size)
