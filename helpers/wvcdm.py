#!/usr/bin/env python3
"""
Widevine CDM key fetcher for Snagger.

Reads a JSON request on stdin, performs the Widevine license exchange using the
project's device.wvd, and prints the resulting content keys as JSON on stdout.

Request  (stdin):  {"pssh": "...", "licenseUrl": "...", "headers": {...}, "device": "device.wvd"}
Response (stdout): {"keys": {"<kid_hex>": "<key_hex>", ...}}   or   {"error": "..."}

The license request is a raw-challenge POST (the scheme used by Tubi's
license.adrise.tv and Pluto's Widevine server). Service-specific auth (drm
tokens etc.) is expected to already be baked into licenseUrl / headers by the
caller.
"""
import sys, json

def main():
    try:
        req = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": f"bad request json: {e}"})); return

    try:
        import requests
        from pywidevine.cdm import Cdm
        from pywidevine.device import Device
        from pywidevine.pssh import PSSH
    except Exception as e:
        print(json.dumps({"error": f"missing deps: {e}"})); return

    try:
        device_path = req.get("device", "device.wvd")
        pssh = PSSH(req["pssh"])
        license_url = req["licenseUrl"]
        headers = req.get("headers", {}) or {}

        cdm = Cdm.from_device(Device.load(device_path))
        sid = cdm.open()
        try:
            challenge = cdm.get_license_challenge(sid, pssh)
            resp = requests.post(license_url, data=challenge, headers=headers, timeout=20)
            if resp.status_code != 200:
                print(json.dumps({"error": f"license {resp.status_code}: {resp.text[:120]}"})); return
            cdm.parse_license(sid, resp.content)
            keys = {}
            for k in cdm.get_keys(sid):
                if k.type == "CONTENT":
                    keys[k.kid.hex] = k.key.hex()
            print(json.dumps({"keys": keys}))
        finally:
            cdm.close(sid)
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
