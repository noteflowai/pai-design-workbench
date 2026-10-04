"""The agent role signs its Secrets Manager call without boto3; check it matches botocore exactly."""
import datetime
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("server", Path(__file__).resolve().parents[2] / "agentcore/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class SigV4(unittest.TestCase):
    def test_matches_botocore(self):
        try:
            from botocore.auth import SigV4Auth
            from botocore.awsrequest import AWSRequest
            from botocore.credentials import Credentials
        except ImportError:
            self.skipTest("botocore not installed")
        creds = {"key": "AKIDEXAMPLE", "secret": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "token": "session-token"}
        fixed = datetime.datetime(2026, 10, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        captured = {}

        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b"{}"

        def fake_urlopen(req, timeout):
            captured["headers"] = {k.lower(): v for k, v in req.header_items()}
            captured["body"] = req.data
            return Resp()

        class FixedDT(datetime.datetime):
            @classmethod
            def now(cls, tz=None): return fixed

        with mock.patch.object(server, "credentials", return_value=creds), mock.patch("urllib.request.urlopen", fake_urlopen), \
                mock.patch("datetime.datetime", FixedDT):
            server.aws_call("secretsmanager", "ap-northeast-1", "secretsmanager.GetSecretValue", {"SecretId": "arn:aws:secretsmanager:ap-northeast-1:111122223333:secret:x"})
        ref = AWSRequest(method="POST", url="https://secretsmanager.ap-northeast-1.amazonaws.com/", data=captured["body"],
                         headers={"content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.GetSecretValue",
                                  "x-amz-date": "20261001T120000Z", "host": "secretsmanager.ap-northeast-1.amazonaws.com"})
        signer = SigV4Auth(Credentials(creds["key"], creds["secret"], creds["token"]), "secretsmanager", "ap-northeast-1")
        with mock.patch("botocore.auth.get_current_datetime", return_value=fixed.replace(tzinfo=None)):
            signer.add_auth(ref)
        mine = captured["headers"]["authorization"].split("Signature=")[1]
        theirs = ref.headers["Authorization"].split("Signature=")[1]
        self.assertEqual(ref.headers["X-Amz-Date"], captured["headers"]["x-amz-date"])
        self.assertEqual(ref.headers["Authorization"].split("SignedHeaders=")[1].split(",")[0], captured["headers"]["authorization"].split("SignedHeaders=")[1].split(",")[0])
        self.assertEqual(mine, theirs)


class Contract(unittest.TestCase):
    def test_requirements_shape_and_run_id(self):
        with self.assertRaises(server.Refused):
            server.requirements({"maxMassG": 80})
        self.assertTrue(server.RUN_ID.match("pai-ai-0a1b"))
        self.assertFalse(server.RUN_ID.match("../etc"))


class Images(unittest.TestCase):
    PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32

    def item(self, data, media="image/png", digest=None):
        return {"media_type": media, "sha256": digest or server.sha(data), "data": server.base64.b64encode(data).decode()}

    def test_digest_bound_images_only(self):
        self.assertEqual(server.images_of({}), [])
        self.assertEqual(server.images_of({"images": [self.item(self.PNG)]})[0][1], server.sha(self.PNG))
        for bad in ([self.item(self.PNG)] * 4, [self.item(self.PNG, digest="0" * 64)], [self.item(self.PNG, media="image/jpeg")],
                    [self.item(b"GIF89a" + b"\0" * 8)], [{**self.item(self.PNG), "path": "/etc/passwd"}]):
            with self.assertRaises(server.Refused):
                server.images_of({"images": bad})


if __name__ == "__main__":
    unittest.main()
