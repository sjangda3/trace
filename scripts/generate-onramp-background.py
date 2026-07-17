#!/usr/bin/env python3
"""Generate the measured production layers for the OnRamp opening background."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REFERENCE_WIDTH = 1170
REFERENCE_HEIGHT = 876
PERIOD_SIZE = 40
PERIOD_SCALE = 3
ARROW_COLOR = np.array((225.0, 240.0, 255.0), dtype=np.float32)
ALS_BLUR_RADIUS = 6
ALS_ITERATIONS = 5

# Coordinates are relative to the designed page crop after removing the
# screenshot's one-pixel side frame and sixteen-pixel black top strip.
FOREGROUND_RECTS = (
    (34, 4, 135, 49),
    (466, 4, 712, 49),
    (1004, 0, 1134, 54),
    (397, 360, 774, 526),
)

# The wider mask removes the antialiased foreground edges before harmonic
# reconstruction. It is intentionally limited to pixels obscured by the
# reference's logo, header copy, CTA, and hero copy.
INPAINT_RECTS = (
    (22, 0, 148, 64),
    (446, 0, 734, 68),
    (986, 0, 1152, 72),
    (365, 326, 805, 554),
)


def make_rect_mask(rects: tuple[tuple[int, int, int, int], ...]) -> Image.Image:
    mask = Image.new("L", (REFERENCE_WIDTH, REFERENCE_HEIGHT), 0)
    draw = ImageDraw.Draw(mask)
    for left, top, right, bottom in rects:
        draw.rounded_rectangle(
            (left, top, right, bottom),
            radius=14,
            fill=255,
        )
    return mask


def resize_scalar_grid(
    values: np.ndarray,
    width: int,
    height: int,
    blur_radius: float,
) -> np.ndarray:
    low = float(np.min(values))
    high = float(np.max(values))
    normalized = np.uint8(
        np.clip((values - low) / max(high - low, 1e-5), 0.0, 1.0) * 255.0
    )
    image = Image.fromarray(normalized)
    image = image.filter(ImageFilter.GaussianBlur(blur_radius))
    image = image.resize((width, height), Image.Resampling.BICUBIC)
    image = image.filter(ImageFilter.GaussianBlur(2))
    return np.asarray(image, dtype=np.float32) / 255.0 * (high - low) + low


def harmonic_inpaint(
    values: np.ndarray,
    visible: np.ndarray,
    step: int = 6,
) -> np.ndarray:
    """Fill hidden regions with a smooth Laplace interpolation.

    Solving on a small grid keeps the generator deterministic and avoids the
    rectangular smears produced by repeatedly blurring the foreground boxes.
    """

    height, width = visible.shape
    channels = 1 if values.ndim == 2 else values.shape[2]
    source = values[:, :, None] if values.ndim == 2 else values
    grid_height = (height + step - 1) // step
    grid_width = (width + step - 1) // step
    grid = np.full((grid_height, grid_width, channels), np.nan, dtype=np.float32)

    for grid_y in range(grid_height):
        top = grid_y * step
        bottom = min(top + step, height)
        for grid_x in range(grid_width):
            left = grid_x * step
            right = min(left + step, width)
            block_visible = visible[top:bottom, left:right]
            visible_count = int(block_visible.sum())
            if visible_count < max(3, int(block_visible.size * 0.35)):
                continue
            grid[grid_y, grid_x] = source[top:bottom, left:right][block_visible].mean(
                axis=0
            )

    fixed = np.isfinite(grid[:, :, 0])
    seeded = fixed.copy()

    # Seed every hidden cell from its nearest known neighborhood.
    for _ in range(600):
        if seeded.all():
            break
        total = np.zeros_like(grid)
        count = np.zeros((grid_height, grid_width), dtype=np.float32)
        total[1:] += np.nan_to_num(grid[:-1]) * seeded[:-1, :, None]
        count[1:] += seeded[:-1]
        total[:-1] += np.nan_to_num(grid[1:]) * seeded[1:, :, None]
        count[:-1] += seeded[1:]
        total[:, 1:] += np.nan_to_num(grid[:, :-1]) * seeded[:, :-1, None]
        count[:, 1:] += seeded[:, :-1]
        total[:, :-1] += np.nan_to_num(grid[:, 1:]) * seeded[:, 1:, None]
        count[:, :-1] += seeded[:, 1:]
        update = (~seeded) & (count > 0)
        grid[update] = total[update] / count[update, None]
        seeded |= update

    # Relax only the reconstructed cells; measured cells remain fixed boundary
    # conditions. This removes the wavefront facets from the initial seed.
    for _ in range(1200):
        total = np.zeros_like(grid)
        count = np.zeros((grid_height, grid_width), dtype=np.float32)
        total[1:] += grid[:-1]
        count[1:] += 1
        total[:-1] += grid[1:]
        count[:-1] += 1
        total[:, 1:] += grid[:, :-1]
        count[:, 1:] += 1
        total[:, :-1] += grid[:, 1:]
        count[:, :-1] += 1
        average = total / count[:, :, None]
        grid[~fixed] = average[~fixed]

    layers = [
        resize_scalar_grid(grid[:, :, channel], width, height, 0.8)
        for channel in range(channels)
    ]
    result = np.stack(layers, axis=2)
    return result[:, :, 0] if values.ndim == 2 else result


def blur_unit(values: np.ndarray, radius: float) -> np.ndarray:
    image = Image.fromarray(
        np.uint8(np.clip(values, 0.0, 1.0) * 255.0)
    )
    return (
        np.asarray(image.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)
        / 255.0
    )


def blur_signed(values: np.ndarray, radius: float) -> np.ndarray:
    magnitude = max(float(np.max(np.abs(values))), 1e-5)
    encoded = np.uint8(
        np.clip(values / magnitude * 0.5 + 0.5, 0.0, 1.0) * 255.0
    )
    blurred = np.asarray(
        Image.fromarray(encoded).filter(ImageFilter.GaussianBlur(radius)),
        dtype=np.float32,
    )
    return (blurred / 255.0 - 0.5) * 2.0 * magnitude


def smoothstep(edge0: float, edge1: float, values: np.ndarray) -> np.ndarray:
    unit = np.clip((values - edge0) / (edge1 - edge0), 0.0, 1.0)
    return unit * unit * (3.0 - 2.0 * unit)


def make_initial_field(
    source: Image.Image,
    visible: np.ndarray,
    soft_mask: np.ndarray,
) -> np.ndarray:
    # The target's field is the dark inter-arrow baseline, not a period-wide
    # average. MinFilter removes the bright arrow body before the small blur
    # restores the broad continuous blue field.
    measured = source.filter(ImageFilter.MinFilter(5))
    measured = measured.filter(ImageFilter.GaussianBlur(5))
    measured_values = np.asarray(measured, dtype=np.float32)
    reconstructed = harmonic_inpaint(measured_values, visible)
    return (
        measured_values * (1.0 - soft_mask[:, :, None])
        + reconstructed * soft_mask[:, :, None]
    )


def extract_layers(
    target: np.ndarray,
    initial_field: np.ndarray,
    visible: np.ndarray,
    soft_mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    height, width = target.shape[:2]
    yy, xx = np.indices((height, width))

    # The measured period is 40/3 CSS px. A 40px source tile rendered at that
    # size maps each screenshot pixel center to (3*x+1) mod 40.
    phase = (
        ((PERIOD_SCALE * yy + 1) % PERIOD_SIZE) * PERIOD_SIZE
        + ((PERIOD_SCALE * xx + 1) % PERIOD_SIZE)
    )

    direction = ARROW_COLOR[None, None, :] - initial_field
    residual = target - initial_field
    projected = np.sum(direction * residual, axis=2)
    alpha = np.clip(
        projected / np.maximum(np.sum(direction * direction, axis=2), 1.0),
        0.0,
        1.0,
    )
    valid = visible & (projected >= 0.0)

    density_image = Image.fromarray(np.uint8(alpha * 255.0))
    density_image = density_image.filter(ImageFilter.MaxFilter(15))
    density_image = density_image.filter(ImageFilter.GaussianBlur(ALS_BLUR_RADIUS))
    density = np.asarray(density_image, dtype=np.float32) / 255.0

    motif = np.zeros((PERIOD_SIZE, PERIOD_SIZE), dtype=np.float32)
    for _ in range(ALS_ITERATIONS):
        weights = valid & (density > 0.01)
        numerator = np.bincount(
            phase[weights].ravel(),
            weights=(alpha[weights] * density[weights]).ravel(),
            minlength=PERIOD_SIZE * PERIOD_SIZE,
        )
        denominator = np.bincount(
            phase[weights].ravel(),
            weights=(density[weights] * density[weights]).ravel(),
            minlength=PERIOD_SIZE * PERIOD_SIZE,
        )
        motif = (numerator / np.maximum(denominator, 1e-6)).reshape(
            PERIOD_SIZE,
            PERIOD_SIZE,
        )
        motif = np.clip(motif, 0.0, None)

        scale = float(np.percentile(motif, 99.5))
        motif = np.clip(motif / max(scale, 1e-6), 0.0, 1.0)
        density = np.clip(density * scale, 0.0, 1.0)

        motif_pixels = motif.ravel()[phase]
        visible_float = valid.astype(np.float32)
        density = blur_unit(
            alpha * motif_pixels * visible_float,
            ALS_BLUR_RADIUS,
        ) / np.maximum(
            blur_unit(
                motif_pixels * motif_pixels * visible_float,
                ALS_BLUR_RADIUS,
            ),
            0.01,
        )
        density = np.clip(density, 0.0, 1.0)

    # Remove the tile's translucent pedestal and absorb it into the field. This
    # preserves the reconstruction while giving CSS a genuinely transparent
    # cell background.
    pedestal = float(np.percentile(motif, 1.0))
    motif = np.clip(
        (motif - pedestal) / max(1.0 - pedestal, 1e-6),
        0.0,
        1.0,
    )
    field = initial_field + (pedestal * density)[:, :, None] * (
        ARROW_COLOR[None, None, :] - initial_field
    )
    density = np.clip(
        density
        * (1.0 - pedestal)
        / np.maximum(1.0 - pedestal * density, 1e-4),
        0.0,
        1.0,
    )

    # Reconstruct the pixels hidden by the reference foreground, then blend the
    # result through a soft mask so the production layers remain continuous.
    reconstructed_density = harmonic_inpaint(density, visible)
    density = density * (1.0 - soft_mask) + reconstructed_density * soft_mask
    # The reference reserves a clean navy header band before the arrow field
    # enters. Reapply that measured entrance after header-copy inpainting so a
    # synthetic vertical column cannot leak into the top edge.
    top_entry = smoothstep(
        38.0,
        72.0,
        np.arange(height, dtype=np.float32),
    )
    density *= top_entry[:, None]
    reconstructed_field = harmonic_inpaint(field, visible)
    field = (
        field * (1.0 - soft_mask[:, :, None])
        + reconstructed_field * soft_mask[:, :, None]
    )

    effective_alpha = motif.ravel()[phase] * density
    composite = field + effective_alpha[:, :, None] * (
        ARROW_COLOR[None, None, :] - field
    )
    return motif, density, field, composite


def calibrate_field(
    target: np.ndarray,
    motif: np.ndarray,
    density: np.ndarray,
    field: np.ndarray,
    composite: np.ndarray,
    visible: np.ndarray,
    soft_mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Apply only the target's broad residual field, never its foreground.

    The ALS pass solves the periodic arrow layer first. This final low-frequency
    calibration accounts for the reference's subtle asymmetric blue curtains
    without baking the arrow lattice or obscuring foreground into the field.
    """

    residual = target - composite
    reconstructed = harmonic_inpaint(residual, visible)
    residual = (
        residual * (1.0 - soft_mask[:, :, None])
        + reconstructed * soft_mask[:, :, None]
    )
    correction = np.stack(
        [
            blur_signed(residual[:, :, channel], 13)
            for channel in range(residual.shape[2])
        ],
        axis=2,
    )
    field = np.clip(field + correction, 0.0, 255.0)

    yy, xx = np.indices(visible.shape)
    phase = (
        ((PERIOD_SCALE * yy + 1) % PERIOD_SIZE) * PERIOD_SIZE
        + ((PERIOD_SCALE * xx + 1) % PERIOD_SIZE)
    )
    effective_alpha = motif.ravel()[phase] * density
    composite = field + effective_alpha[:, :, None] * (
        ARROW_COLOR[None, None, :] - field
    )
    return field, composite


def generate(source_path: Path, output_dir: Path) -> None:
    source = Image.open(source_path).convert("RGB")
    if source.size != (1172, 892):
        raise ValueError(f"Expected the 1172x892 reference screenshot, got {source.size}.")

    output_dir.mkdir(parents=True, exist_ok=True)
    crop = source.crop((1, 16, 1171, 892))
    target = np.asarray(crop, dtype=np.float32)

    inpaint_mask = make_rect_mask(INPAINT_RECTS)
    soft_mask = np.asarray(
        inpaint_mask.filter(ImageFilter.GaussianBlur(10)),
        dtype=np.float32,
    ) / 255.0
    visible = np.asarray(inpaint_mask) == 0
    initial_field = make_initial_field(crop, visible, soft_mask)
    motif, density, field, composite = extract_layers(
        target,
        initial_field,
        visible,
        soft_mask,
    )
    field, composite = calibrate_field(
        target,
        motif,
        density,
        field,
        composite,
        visible,
        soft_mask,
    )

    tile = np.empty((PERIOD_SIZE, PERIOD_SIZE, 4), dtype=np.uint8)
    tile[:, :, :3] = np.uint8(ARROW_COLOR)
    tile[:, :, 3] = np.uint8(np.clip(motif, 0.0, 1.0) * 255.0)
    Image.fromarray(tile).save(
        output_dir / "onboarding-onramp-arrow-tile.png",
        optimize=True,
    )

    density_rgba = np.full(
        (REFERENCE_HEIGHT, REFERENCE_WIDTH, 4),
        255,
        dtype=np.uint8,
    )
    density_rgba[:, :, 3] = np.uint8(np.clip(density, 0.0, 1.0) * 255.0)
    Image.fromarray(density_rgba).save(
        output_dir / "onboarding-onramp-density.png",
        optimize=True,
    )
    Image.fromarray(np.uint8(np.clip(field, 0.0, 255.0))).save(
        output_dir / "onboarding-onramp-field.png",
        optimize=True,
    )

    metric_visible = np.ones((REFERENCE_HEIGHT, REFERENCE_WIDTH), dtype=bool)
    for left, top, right, bottom in FOREGROUND_RECTS:
        metric_visible[top:bottom, left:right] = False
    error = np.abs(target - composite)
    print(f"masked_mae={error[metric_visible].mean():.6f}")
    print(
        "masked_rmse="
        f"{np.sqrt(np.mean((target - composite)[metric_visible] ** 2)):.6f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    generate(args.source, args.output_dir)


if __name__ == "__main__":
    main()
