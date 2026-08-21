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
STATE_TYPE: Final[str] = "H3_CHAIN_STATE"


class GuideImageSpec(TypedDict):
    """One guide image and its requested pixel-frame anchor."""

    image: torch.Tensor
    frame_index: int
    scene_index: int | None


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
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "Image used as a MiniMax H3 guide anchor.",
                    },
                ),
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
                "scene_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 9999,
                        "step": 1,
                        "tooltip": "One-based scene number for this guide image.",
                    },
                ),
                "guide_images": (
                    GUIDE_IMAGES_TYPE,
                    {
                        "tooltip": (
                            "Optional upstream guide-image chain to append to."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES: tuple[str, ...] = (GUIDE_IMAGES_TYPE,)
    RETURN_NAMES: tuple[str, ...] = ("guide_images",)
    OUTPUT_TOOLTIPS: tuple[str, ...] = (
        "Guide-image chain including this image and upstream anchors.",
    )
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
        scene_index: int | None = None,
    ) -> tuple[GuideImageChain]:
        chain: GuideImageChain = tuple(guide_images or ())
        item: GuideImageSpec = {
            "image": image,
            "frame_index": int(frame_index),
            "scene_index": None if scene_index is None else int(scene_index),
        }
        return (chain + (item,),)


class MiniMaxH3GuideImagesToVideo:
    """Build H3 conditioning from guide images anchored anywhere in the clip."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "clip": (
                    "CLIP",
                    {
                        "tooltip": "MiniMax H3 text/vision encoder.",
                    },
                ),
                "vae": (
                    "VAE",
                    {
                        "tooltip": (
                            "MiniMax H3 video VAE used to encode guide images."
                        ),
                    },
                ),
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": True,
                        "tooltip": (
                            "Prompt encoded together with the ordered guide images."
                        ),
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 1344,
                        "min": 32,
                        "max": comfy_nodes.MAX_RESOLUTION,
                        "step": 32,
                        "tooltip": "Target video width in pixels.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 768,
                        "min": 32,
                        "max": comfy_nodes.MAX_RESOLUTION,
                        "step": 32,
                        "tooltip": "Target video height in pixels.",
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
                "state": (
                    STATE_TYPE,
                    {
                        "tooltip": "Current H3 chain state used to resolve scene-local guides.",
                    },
                ),
            },
            "optional": {
                "guide_images": (
                    GUIDE_IMAGES_TYPE,
                    {
                        "tooltip": (
                            "Guide-image chain produced by MiniMax H3 Guide Image nodes."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES: tuple[str, ...] = ("CONDITIONING", "LATENT")
    RETURN_NAMES: tuple[str, ...] = ("positive", "latent")
    OUTPUT_TOOLTIPS: tuple[str, ...] = (
        "Positive H3 conditioning containing the resolved guide anchors.",
        "Empty aligned MiniMax H3 AV latent for the requested duration.",
    )
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
        state: dict[str, Any],
        guide_images: GuideImageChain | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        latent, frame_count = _empty_av_latent(width, height, length)
        scene_guides: GuideImageChain = self._select_scene_guides(
            guide_images or (),
            state,
        )
        raw_scene_guides, visible_start_raw_index = self._map_visible_guides_to_raw(
            scene_guides,
            state,
            frame_count,
        )
        resolved_guides: list[ResolvedGuide] = self._resolve_guides(
            raw_scene_guides,
            frame_count,
        )

        prompt_images: list[torch.Tensor] = []
        keyframes: list[dict[str, Any]] = []

        for resolved_index, image in resolved_guides:
            crop: str = (
                "disabled"
                if resolved_index == visible_start_raw_index
                else "center"
            )
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
    def _select_scene_guides(
        guide_images: GuideImageChain,
        state: dict[str, Any],
    ) -> GuideImageChain:
        """Return only the guides that apply to the current chain scene."""
        if not isinstance(state, dict) or not isinstance(state.get("plan"), dict):
            raise ValueError("Guide Images to Video requires a valid H3 Chain state.")

        shots: Any = state["plan"].get("shots")
        if not isinstance(shots, list) or not shots:
            raise ValueError("H3 Chain state does not contain a valid scene plan.")

        scene_index: int = int(state.get("index", -1))
        scene_count: int = len(shots)

        if scene_index < 1 or scene_index > scene_count:
            raise ValueError(
                f"H3 Chain state scene index {scene_index} is outside "
                f"the plan's 1..{scene_count} range."
            )

        current_guides: list[GuideImageSpec] = []
        previous_end: GuideImageSpec | None = None
        used_keys: set[tuple[int, int]] = set()

        for item in guide_images:
            item_scene_raw: int | None = item.get("scene_index")
            if item_scene_raw is None:
                raise ValueError(
                    "Every scene-aware guide image requires a scene_index."
                )

            item_scene: int = int(item_scene_raw)
            frame_index: int = int(item["frame_index"])

            if item_scene < 1 or item_scene > scene_count:
                raise ValueError(
                    f"Guide scene_index {item_scene} is outside "
                    f"the plan's 1..{scene_count} range."
                )

            if frame_index < -1:
                raise ValueError(
                    f"Invalid guide frame_index {frame_index} for scene "
                    f"{item_scene}. Only non-negative indices and -1 are supported."
                )

            key: tuple[int, int] = (item_scene, frame_index)
            if key in used_keys:
                raise ValueError(
                    f"More than one guide image targets scene {item_scene}, "
                    f"frame {frame_index}."
                )
            used_keys.add(key)

            if item_scene == scene_index:
                current_guides.append(item)

            if (
                scene_index > 1
                and item_scene == scene_index - 1
                and frame_index == -1
            ):
                previous_end = item

        if scene_index == 1:
            if not any(int(item["frame_index"]) == 0 for item in current_guides):
                raise ValueError("Scene 1 requires an explicit guide at frame 0.")
        else:
            if previous_end is None:
                raise ValueError(
                    f"Scene {scene_index} requires the frame -1 guide from "
                    f"scene {scene_index - 1} as its inherited start."
                )

            if any(int(item["frame_index"]) == 0 for item in current_guides):
                raise ValueError(
                    f"Scene {scene_index} defines an explicit frame 0 guide, "
                    f"but scene {scene_index - 1} already provides its "
                    "inherited start guide."
                )

            inherited: GuideImageSpec = {
                "image": previous_end["image"],
                "frame_index": 0,
                "scene_index": scene_index,
            }
            current_guides.insert(0, inherited)

        if (
            scene_index < scene_count
            and not any(int(item["frame_index"]) == -1 for item in current_guides)
        ):
            raise ValueError(
                f"Scene {scene_index} requires a guide at frame -1 because "
                "another scene follows it."
            )

        return tuple(current_guides)

    @staticmethod
    def _map_visible_guides_to_raw(
        guide_images: GuideImageChain,
        state: dict[str, Any],
        frame_count: int,
    ) -> tuple[GuideImageChain, int]:
        """Map visible scene guide indices onto the raw generation timeline."""
        scene_index: int = int(state["index"])
        shot: dict[str, Any] = state["plan"]["shots"][scene_index - 1]

        raw_frames: int = int(shot["raw_frames"])
        delivered_frames: int = int(shot["delivered_frames"])

        if raw_frames != frame_count:
            raise ValueError(
                f"Scene {scene_index} expects {raw_frames} raw frames, "
                f"but Guide Images to Video created {frame_count}."
            )

        if delivered_frames < 1 or delivered_frames > raw_frames:
            raise ValueError(
                f"Scene {scene_index} has invalid delivered frame count "
                f"{delivered_frames} for {raw_frames} raw frames."
            )

        prefix_frames: int = raw_frames - delivered_frames
        mapped: list[GuideImageSpec] = []

        for item in guide_images:
            frame_index: int = int(item["frame_index"])
            visible_index: int = (
                delivered_frames - 1 if frame_index == -1 else frame_index
            )

            if visible_index < 0 or visible_index >= delivered_frames:
                raise ValueError(
                    f"Guide frame_index {frame_index} for scene {scene_index} "
                    f"is outside the visible scene's {delivered_frames} frames."
                )

            mapped.append(
                {
                    "image": item["image"],
                    "frame_index": prefix_frames + visible_index,
                    "scene_index": item["scene_index"],
                }
            )

        return tuple(mapped), prefix_frames

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
