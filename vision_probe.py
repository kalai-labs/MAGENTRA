#!/usr/bin/env python3
"""Can this endpoint's model actually SEE an image?

Answer it before wiring the model into Magentra, because a model that cannot
see one does not say so: it answers anyway, describing nothing, and the failure
only shows up as an agent confidently discussing a screenshot it never received.

Two forms are tested, because they are different code paths on the provider
side and only one of them is what Magentra sends:

  1. remote URL  — {"image_url": {"url": "https://…"}}, the form in most docs
  2. data URL    — {"image_url": {"url": "data:image/jpeg;base64,…"}}

MAGENTRA SENDS FORM 2. An image the user attaches is bytes on this machine;
there is no URL to hand anybody. So form 2 is the one that decides whether the
model works as a Magentra vision model — form 1 is here only to tell "the model
is blind" apart from "the provider rejects inline images".

The key is read from ~/.magentra/profiles.json (the app's own store) so no
credential has to be typed or pasted into a file. $FIREWORKS_API_KEY wins if set.

Usage
  python3 vision_probe.py                          # default model, default image
  python3 vision_probe.py --list                    # what this account can serve
  python3 vision_probe.py --model accounts/fireworks/models/<id>
  python3 vision_probe.py --image ./screenshot.png  # a local file, like a real attachment
  python3 vision_probe.py --profile fireworks-mini  # take key+URL+model from this profile
  python3 vision_probe.py --stream                  # the exact SSE path Magentra uses
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_MODEL = "accounts/fireworks/models/kimi-k2p7-code"
DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1"
# A photo with enough in it that a real answer and a bluffed one read differently.
DEFAULT_IMAGE = (
    "https://images.unsplash.com/photo-1582538885592-e70a5d7ab3d3"
    "?ixlib=rb-4.0.3&auto=format&fit=crop&w=1024&q=80"
)
PROFILES = Path.home() / ".magentra" / "profiles.json"

# The prompt Magentra's vision side-call uses, shortened. Deliberately asks for
# specifics: "a photograph of a scene" is what a model that sees nothing says.
PROMPT = (
    "Describe this image. Name the main subject, the colours, and transcribe any text "
    "you can read in it. If you cannot see an image at all, reply with exactly: NO IMAGE RECEIVED."
)


def load_profiles():
    try:
        return json.loads(PROFILES.read_text())
    except (OSError, ValueError) as err:
        print(f"! could not read {PROFILES}: {err}", file=sys.stderr)
        return []


def resolve_connection(profile_name, model, base_url):
    """Key, base URL and model, from the environment or the app's profile store."""
    key = os.environ.get("FIREWORKS_API_KEY", "").strip()
    profiles = load_profiles()

    profile = None
    if profile_name:
        profile = next((p for p in profiles if p.get("name") == profile_name), None)
        if profile is None:
            names = ", ".join(p.get("name", "?") for p in profiles) or "(none saved)"
            sys.exit(f"no saved profile named {profile_name!r}. Saved: {names}")
    elif not key:
        # Any profile pointing at the same host will do — it is the account's key.
        profile = next((p for p in profiles if base_url.split("/")[2] in (p.get("baseUrl") or "")), None)

    if profile:
        key = key or (profile.get("apiKey") or "").strip()
        if profile_name:
            base_url = (profile.get("baseUrl") or base_url).rstrip("/")
            model = model or profile.get("model") or DEFAULT_MODEL

    if not key:
        sys.exit(
            "no API key found. Set FIREWORKS_API_KEY, or save a profile for this "
            f"endpoint in the app (looked in {PROFILES})."
        )
    return key, base_url.rstrip("/"), model or DEFAULT_MODEL


def post(url, key, body, stream=False):
    """POST JSON; returns (status, text). Never raises on an HTTP error status —
    the error BODY is the interesting part (it says why the image was refused)."""
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")
    except Exception as err:  # network, DNS, TLS
        return 0, f"{type(err).__name__}: {err}"


def answer_of(status, raw, stream):
    """The assistant's text, or a readable account of why there isn't one."""
    if status != 200:
        return None, f"HTTP {status}: {raw.strip()[:600]}"
    if stream:
        text = ""
        for line in raw.splitlines():
            if not line.startswith("data: ") or line.strip() == "data: [DONE]":
                continue
            try:
                chunk = json.loads(line[6:])
            except ValueError:
                continue
            for choice in chunk.get("choices", []):
                text += (choice.get("delta") or {}).get("content") or ""
        return text.strip(), None
    try:
        body = json.loads(raw)
    except ValueError:
        return None, f"response was not JSON: {raw[:300]}"
    choices = body.get("choices") or []
    if not choices:
        return None, f"no choices in response: {raw[:300]}"
    return (choices[0].get("message") or {}).get("content", "").strip(), None


def image_parts(source):
    """Both forms of the same picture: the remote URL and the inline data URL.

    A local path has no remote form — which is exactly the real case: a user's
    attachment and a screenshot on disk are bytes, so only the data URL exists.
    """
    if source.startswith(("http://", "https://")):
        raw = urllib.request.urlopen(source, timeout=60).read()
        media = "image/jpeg" if source.lower().rstrip("/").find(".png") == -1 else "image/png"
        remote = source
    else:
        path = Path(source).expanduser()
        raw = path.read_bytes()
        ext = path.suffix.lower()
        media = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "image/png")
        remote = None
    data_url = f"data:{media};base64,{base64.b64encode(raw).decode()}"
    return remote, data_url, len(raw), media


def probe(label, url, key, model, image_url, stream, note):
    print(f"\n── {label} " + "─" * max(0, 58 - len(label)))
    print(f"   {note}")
    body = {
        "model": model,
        "max_tokens": 512,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        }],
    }
    if stream:
        body["stream"] = True
    status, raw = post(f"{url}/chat/completions", key, body, stream)
    text, problem = answer_of(status, raw, stream)
    if problem:
        print(f"   ✗ FAILED — {problem}")
        return False
    if not text:
        print("   ✗ FAILED — the model returned an empty answer")
        return False
    if "NO IMAGE RECEIVED" in text.upper():
        print("   ✗ BLIND — the model answered, but said it received no image")
        print(f"     {text[:300]}")
        return False
    print(f"   ✓ answered ({len(text)} chars):\n")
    for line in text.splitlines():
        print(f"     {line}")
    return True


def list_models(url, key):
    req = urllib.request.Request(f"{url}/models", headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            body = json.loads(res.read().decode())
    except Exception as err:
        sys.exit(f"could not list models: {err}")
    ids = sorted(m.get("id", "") for m in body.get("data", []))
    print(f"{len(ids)} model(s) served at {url}:\n")
    for model_id in ids:
        # Not authoritative — the catalog rarely states vision support. A hint only.
        hint = "  ← name suggests vision" if any(
            token in model_id.lower() for token in ("vision", "vl", "llava", "image", "multimodal")
        ) else ""
        print(f"  {model_id}{hint}")
    print("\nThe name proves nothing. Run the probe against a candidate to find out.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=None, help=f"model id (default {DEFAULT_MODEL})")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--image", default=DEFAULT_IMAGE, help="http(s) URL or a local file path")
    ap.add_argument("--profile", default=None, help="take key/baseUrl/model from this saved app profile")
    ap.add_argument("--stream", action="store_true", help="use SSE, exactly as Magentra does")
    ap.add_argument("--list", action="store_true", help="list the models this account can serve")
    args = ap.parse_args()

    key, base_url, model = resolve_connection(args.profile, args.model, args.base_url)
    print(f"endpoint : {base_url}")
    print(f"model    : {model}")
    print(f"key      : {key[:6]}…{key[-4:]} ({'env' if os.environ.get('FIREWORKS_API_KEY') else 'saved profile'})")

    if args.list:
        list_models(base_url, key)
        return

    remote, data_url, size, media = image_parts(args.image)
    print(f"image    : {args.image}")
    print(f"           {size:,} bytes {media} → {len(data_url):,} chars as base64")
    if args.stream:
        print("transport: SSE (stream=true), the same path Magentra uses")

    results = {}
    if remote:
        results["remote URL"] = probe(
            "FORM 1 — remote URL", base_url, key, model, remote, args.stream,
            "what most provider docs show. NOT what Magentra sends.",
        )
    results["data URL"] = probe(
        "FORM 2 — inline base64 data URL", base_url, key, model, data_url, args.stream,
        "THIS is what Magentra sends for an attachment or a screenshot.",
    )

    print("\n" + "=" * 64)
    for name, ok in results.items():
        print(f"  {name:<12} {'PASS' if ok else 'FAIL'}")
    if results.get("data URL"):
        print("\n✓ Usable as a Magentra vision model.")
        print("  Save it as a connection profile, then pick it in")
        print("  Settings → Connection → Vision model, and switch Vision ON.")
    elif results.get("remote URL"):
        print("\n✗ NOT usable: the model can see, but this endpoint refuses inline")
        print("  base64 images — and an attached file has no URL to offer instead.")
    else:
        print("\n✗ NOT usable: this model does not accept images at all.")
        print(f"  Run `python3 {Path(sys.argv[0]).name} --list` and try a vision model.")
    sys.exit(0 if results.get("data URL") else 1)


if __name__ == "__main__":
    main()
