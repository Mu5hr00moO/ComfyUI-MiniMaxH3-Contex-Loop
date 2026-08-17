"""MiniMax H3 guide-image nodes with arbitrary timeline anchors."""

from __future__ import annotations

from typing import Any, Final, TypeAlias, TypedDict

import torch

import comfy.model_management
import comfy.nested_tensor
import comfy.utils
import node_helpers
import nodes as comfy_nodes


FPS: Final[int] = 24
AUDIO_LATENT_FPS: Final[int] = 40
GUIDE_IMAGES_TYPE: Final[str] = "MINIMAX_H3_GUIDE_IMAGES"


class GuideImageSpec(TypedDict):
    """One guide image and its requested pixel-frame anchor."""

    image: torch.Tensor
    frame_index: int


GuideImageChain: TypeAlias = tuple[GuideImageSpec, ...]
ResolvedGuide: TypeAlias = tuple[int, torch.Tensor]


def _align_frame_count(frame_count: int) -> int:
    """Snap a requested frame count up to MiniMax H3's 17k+5 grid."""
    aligned: int = int(frame_count)
    while aligned % 17 != 5:
        aligned += 1
    return aligned


def _video_latent_t(frame_count: int) -> int:
    """Return the H3 video latent length for an aligned pixel-frame count."""
    if frame_count <= 5:
        return 2
    return ((frame_count - 5) // 17) * 5 + 2


def _temporal_shape(length: int) -> tuple[int, int, int]:
    """Return aligned pixel, video-latent, and audio-latent lengths."""
    frame_count: int = _align_frame_count(max(5, int(length)))
    duration: float = frame_count / FPS
    audio_t: int = round(duration * AUDIO_LATENT_FPS)
    return frame_count, _video_latent_t(frame_count), audio_t


def _empty_av_latent(
    width: int,
    height: int,
    length: int,
    batch_size: int = 1,
) -> tuple[dict[str, Any], int]:
    """Create an empty MiniMax H3 nested video/audio latent."""
    frame_count, latent_t, audio_t = _temporal_shape(length)
    device: Any = comfy.model_management.intermediate_device()
    video: torch.Tensor = torch.zeros(
        [batch_size, 24, latent_t, height // 16, width // 16],
        device=device,
    )
    audio: torch.Tensor = torch.zeros(
        [batch_size, 32, 2, audio_t],
        device=device,
    )
    latent: dict[str, Any] = {
        "samples": comfy.nested_tensor.NestedTensor((video, audio)),
    }
    return latent, frame_count


def _resize_image(
    image: torch.Tensor,
    width: int,
    height: int,
    crop: str,
) -> torch.Tensor:
    """Resize a ComfyUI image tensor using the stock H3 guide convention."""
    samples: torch.Tensor = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(
        samples,
        width,
        height,
        "lanczos",
        crop,
    )
    return samples.movedim(1, -1)


class MiniMaxH3GuideImage:
    """Append one image anchor to a chain of MiniMax H3 guide images."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "frame_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": -9999,
                        "max": 9999,
                        "step": 1,
                        "tooltip": (
                            "Pixel-frame index for this guide image. Negative "
                            "values count from the end; -1 is the last frame."
                        ),
                    },
                ),
            },
            "optional": {
                "guide_images": (GUIDE_IMAGES_TYPE,),
            },
        }

    RETURN_TYPES: tuple[str, ...] = (GUIDE_IMAGES_TYPE,)
    RETURN_NAMES: tuple[str, ...] = ("guide_images",)
    FUNCTION: str = "build"
    CATEGORY: str = "model/conditioning/minimax"
    DESCRIPTION: str = (
        "Add one MiniMax H3 guide image at a chosen frame index. Chain several "
        "nodes through guide_images."
    )

    def build(
        self,
        image: torch.Tensor,
        frame_index: int,
        guide_images: GuideImageChain | None = None,
    ) -> tuple[GuideImageChain]:
        chain: GuideImageChain = tuple(guide_images or ())
        item: GuideImageSpec = {
            "image": image,
            "frame_index": int(frame_index),
        }
        return (chain + (item,),)


class MiniMaxH3GuideImagesToVideo:
    """Build H3 conditioning from guide images anchored anywhere in the clip."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": True,
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1344,
                        "min": 32,
                        "max": comfy_nodes.MAX_RESOLUTION,
                        "step": 32,
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 768,
                        "min": 32,
                        "max": comfy_nodes.MAX_RESOLUTION,
                        "step": 32,
                    },
                ),
                "length": (
                    "INT",
                    {
                        "default": 124,
                        "min": 5,
                        "max": 3600,
                        "step": 17,
                        "tooltip": (
                            "Frame count at 24 fps, snapped up to the model's "
                            "17k+5 frame grid."
                        ),
                    },
                ),
            },
            "optional": {
                "guide_images": (GUIDE_IMAGES_TYPE,),
            },
        }

    RETURN_TYPES: tuple[str, ...] = ("CONDITIONING", "LATENT")
    RETURN_NAMES: tuple[str, ...] = ("positive", "latent")
    FUNCTION: str = "execute"
    CATEGORY: str = "model/conditioning/minimax"
    DESCRIPTION: str = (
        "MiniMax H3 image-to-video conditioning with any number of guide images "
        "anchored at arbitrary frame indices."
    )

    def execute(
        self,
        clip: Any,
        vae: Any,
        prompt: str,
        width: int,
        height: int,
        length: int,
        guide_images: GuideImageChain | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        latent, frame_count = _empty_av_latent(width, height, length)
        resolved_guides: list[ResolvedGuide] = self._resolve_guides(
            guide_images or (),
            frame_count,
        )

        prompt_images: list[torch.Tensor] = []
        keyframes: list[dict[str, Any]] = []

        for resolved_index, image in resolved_guides:
            crop: str = "disabled" if resolved_index == 0 else "center"
            resized: torch.Tensor = _resize_image(
                image[:1],
                width,
                height,
                crop,
            )
            prompt_images.append(resized)
            keyframes.append(
                {
                    "resolved_frame_index": resolved_index,
                    "image": resized,
                }
            )

        tokens: Any = clip.tokenize(prompt, images=prompt_images)
        conditioning: Any = clip.encode_from_tokens_scheduled(tokens)

        if keyframes:
            for keyframe in keyframes:
                keyframe["latent"] = vae.encode(keyframe.pop("image"))
            conditioning = node_helpers.conditioning_set_values(
                conditioning,
                {"minimax_keyframes": keyframes},
            )

        return conditioning, latent

    @staticmethod
    def _resolve_guides(
        guide_images: GuideImageChain,
        frame_count: int,
    ) -> list[ResolvedGuide]:
        """Resolve negative indices, reject collisions, and sort by time."""
        resolved: list[ResolvedGuide] = []
        used_indices: set[int] = set()

        for item in guide_images:
            frame_index: int = int(item["frame_index"])
            resolved_index: int = (
                frame_index if frame_index >= 0 else frame_count + frame_index
            )

            if resolved_index < 0 or resolved_index >= frame_count:
                raise ValueError(
                    f"Guide frame index {frame_index} resolves to "
                    f"{resolved_index}, outside the video's {frame_count} "
                    "frames."
                )
            if resolved_index in used_indices:
                raise ValueError(
                    "More than one guide image resolves to frame "
                    f"{resolved_index}."
                )

            used_indices.add(resolved_index)
            resolved.append((resolved_index, item["image"]))

        resolved.sort(key=lambda item: item[0])
        return resolved


NODE_CLASS_MAPPINGS: dict[str, type] = {
    "MiniMaxH3GuideImage": MiniMaxH3GuideImage,
    "MiniMaxH3GuideImagesToVideo": MiniMaxH3GuideImagesToVideo,
}

NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {
    "MiniMaxH3GuideImage": "MiniMax H3 Guide Image",
    "MiniMaxH3GuideImagesToVideo": "MiniMax H3 Guide Images to Video",
}
