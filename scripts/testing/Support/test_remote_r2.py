"""Remote runner safety checks use mocks and never contact Cloudflare."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_r2', pathlib.Path(__file__).resolve().parents[1] / 'remote-r2.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
ACCOUNT = 'a' * 32

class RemoteR2Tests(unittest.TestCase):
    def test_default_plan_never_uses_network(self):
        with patch.object(remote, 'api', side_effect=AssertionError('network')), patch('builtins.print'):
            self.assertEqual(remote.main([]), 0)

    def test_names_are_unique_and_scoped(self):
        first, second = remote.plan(ACCOUNT), remote.plan(ACCOUNT)
        remote.validate_manifest(first)
        self.assertNotEqual(first['resource']['identifier'], second['resource']['identifier'])
        first['resource']['identifier'] = 'existing-production'
        with self.assertRaises(ValueError):
            remote.validate_manifest(first)

    def test_approval_is_not_a_hard_cap(self):
        approval = {'scope': remote.SCOPE, 'account': ACCOUNT, 'approvedBudgetUsd': 5,
                    'approvedBy': 'operator', 'approvedAt': '2026-09-08T00:00:00Z', 'acknowledgeNotHardCap': True}
        remote.validate_approval(approval, ACCOUNT)
        for amount in [True, 0, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                remote.validate_approval({**approval, 'approvedBudgetUsd': amount}, ACCOUNT)
        with self.assertRaises(ValueError):
            remote.validate_approval({**approval, 'acknowledgeNotHardCap': False}, ACCOUNT)

    def test_unconfirmed_creation_never_deletes(self):
        manifest = remote.plan(ACCOUNT)
        manifest['resource']['state'] = 'create-pending'
        with patch.object(remote, 'api', side_effect=AssertionError('network')):
            with self.assertRaises(ValueError):
                remote.cleanup(manifest, pathlib.Path('/unused'))

    def test_cleanup_only_recorded_object_and_bucket_and_is_repeatable(self):
        manifest = remote.plan(ACCOUNT)
        manifest['resource']['state'] = 'created'
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'manifest.json'
            with patch.object(remote.subprocess, 'run') as command, patch.object(remote, 'api', return_value=(200, {})) as api:
                command.return_value.returncode = 0
                remote.cleanup(manifest, path)
                self.assertEqual([call.args[0][-2] for call in command.call_args_list], [manifest['resource']['identifier'] + '/' + key for key in manifest['objects']])
                api.assert_called_once_with(ACCOUNT, 'DELETE', '/' + manifest['resource']['identifier'])
                remote.cleanup(manifest, path)
                self.assertEqual(command.call_count, 2)
            self.assertEqual(json.loads(path.read_text())['resource']['state'], 'deleted')

    def test_modified_object_scope_rejected(self):
        manifest = remote.plan(ACCOUNT)
        manifest['objects'].append('unrelated')
        with self.assertRaises(ValueError):
            remote.validate_manifest(manifest)

    def test_failed_bucket_cleanup_keeps_recovery_state(self):
        manifest = remote.plan(ACCOUNT)
        manifest['resource']['state'] = 'created'
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'manifest.json'
            with patch.object(remote.subprocess, 'run') as command, patch.object(remote, 'api', return_value=(503, None)):
                command.return_value.returncode = 0
                with self.assertRaises(RuntimeError):
                    remote.cleanup(manifest, path)
            self.assertEqual(json.loads(path.read_text())['resource']['state'], 'cleanup-pending')

    def test_stale_build_stops_before_cloudflare_or_manifest_creation(self):
        approval = {'scope': remote.SCOPE, 'account': ACCOUNT, 'approvedBudgetUsd': 5,
                    'approvedBy': 'operator', 'approvedAt': '2026-09-08T00:00:00Z', 'acknowledgeNotHardCap': True}
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            approved = directory / 'approval.json'
            approved.write_text(json.dumps(approval))
            manifest = directory / 'run.json'
            with patch.object(remote, 'verify_build', side_effect=RuntimeError('stale')), patch.object(remote, 'api', side_effect=AssertionError('network')):
                with self.assertRaises(RuntimeError):
                    remote.main(['execute', '--account', ACCOUNT, '--approval', str(approved), '--manifest', str(manifest)])
            self.assertFalse(manifest.exists())

    def test_build_verification_failure_is_not_ignored(self):
        with patch.object(remote.subprocess, 'run') as command:
            command.return_value.returncode = 1
            with self.assertRaises(RuntimeError):
                remote.verify_build()
            self.assertIn('verifyBuild();', command.call_args.args[0][-1])

    def test_old_approval_cannot_expand_scope(self):
        with self.assertRaises(ValueError):
            remote.validate_approval({'account': ACCOUNT, 'scope': 'remote-r2-ssec'}, ACCOUNT)

    def test_legacy_manifest_cleanup_remains_narrow(self):
        manifest = remote.plan(ACCOUNT)
        manifest.update(schema=1, objects=[remote.OBJECT])
        manifest['resource']['state'] = 'created'
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(remote.subprocess, 'run') as command, patch.object(remote, 'api', return_value=(200, {})):
                command.return_value.returncode = 0
                remote.cleanup(manifest, pathlib.Path(directory) / 'manifest.json')
                self.assertEqual(command.call_count, 1)
                self.assertEqual(command.call_args.args[0][-2], manifest['resource']['identifier'] + '/' + remote.OBJECT)

    def test_multipart_receipt_is_persisted_before_continuation(self):
        manifest = remote.plan(ACCOUNT)
        upload = {'key': remote.ARCHIVE_OBJECT, 'identifier': 'upload-example'}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'manifest.json'
            remote.record_receipt(manifest, path, {'phase': 'intent', 'key': remote.ARCHIVE_OBJECT})
            self.assertTrue(json.loads(path.read_text())['multipartIntent'])
            remote.record_receipt(manifest, path, {'phase': 'created', **upload})
            saved = json.loads(path.read_text())
            self.assertEqual(saved['multipart'], [upload])
            self.assertFalse(saved['multipartIntent'])
            with self.assertRaises(ValueError):
                remote.record_receipt(manifest, path, {'phase': 'created', **upload})
            remote.record_receipt(manifest, path, {'phase': 'closed', **upload})
            self.assertTrue(json.loads(path.read_text())['multipartClosed'])

    def test_pending_multipart_creation_refuses_deletion(self):
        manifest = remote.plan(ACCOUNT)
        manifest['resource']['state'] = 'created'
        manifest['multipartIntent'] = True
        with tempfile.TemporaryDirectory() as directory, patch.object(remote.subprocess, 'run', side_effect=AssertionError('delete')):
            with self.assertRaises(RuntimeError):
                remote.cleanup(manifest, pathlib.Path(directory) / 'manifest.json')

    def test_abort_failure_keeps_upload_receipt_and_skips_deletion(self):
        manifest = remote.plan(ACCOUNT)
        manifest['resource']['state'] = 'created'
        manifest['multipart'] = [{'key': remote.ARCHIVE_OBJECT, 'identifier': 'upload-example'}]
        with tempfile.TemporaryDirectory() as directory, patch.object(remote, 'run_worker', return_value={'passed': False}), patch.object(remote.subprocess, 'run', side_effect=AssertionError('delete')):
            path = pathlib.Path(directory) / 'manifest.json'
            with self.assertRaises(RuntimeError):
                remote.cleanup(manifest, path)
            self.assertEqual(json.loads(path.read_text())['multipart'], manifest['multipart'])

    def test_successful_abort_is_recorded_before_object_cleanup(self):
        manifest = remote.plan(ACCOUNT)
        manifest['resource']['state'] = 'created'
        manifest['multipart'] = [{'key': remote.ARCHIVE_OBJECT, 'identifier': 'upload-example'}]
        with tempfile.TemporaryDirectory() as directory, patch.object(remote, 'run_worker', return_value={'passed': True}) as worker, patch.object(remote.subprocess, 'run') as command, patch.object(remote, 'api', return_value=(200, {})):
            command.return_value.returncode = 0
            path = pathlib.Path(directory) / 'manifest.json'
            remote.cleanup(manifest, path)
            worker.assert_called_once_with(manifest, 'cleanup-probe.ts', {}, {'uploads': manifest['multipart']})
            self.assertTrue(json.loads(path.read_text())['multipartClosed'])

    def test_upload_receipt_cannot_reference_other_keys(self):
        with self.assertRaises(ValueError):
            remote.validate_upload({'key': 'unrelated', 'identifier': 'upload-example'})

    def test_positive_only_evidence_is_incomplete_not_passed(self):
        self.assertEqual(remote.probe_status({'positiveChecksPassed': True, 'negativeProof': 'unverified', 'passed': False}), 'incomplete')
        self.assertEqual(remote.probe_status({'positiveChecksPassed': False, 'negativeProof': 'unverified', 'passed': False}), 'failed')
        self.assertEqual(remote.probe_status({'passed': True}), 'passed')

class FreeTierApprovalTests(unittest.TestCase):
    def test_free_tier_requires_fresh_matching_usage_and_headroom(self):
        evidence = {'account': ACCOUNT, 'checkedAt': remote.datetime.datetime.now(remote.datetime.timezone.utc).isoformat(),
                    'classA': 8, 'classB': 420, 'storagePeakBytes': 150127, 'sourceSha256': 'a' * 64}
        approval = {'scope': remote.SCOPE, 'account': ACCOUNT, 'costPolicy': 'free-tier',
                    'approvedBy': 'user', 'approvedAt': evidence['checkedAt'], 'usageEvidence': evidence}
        remote.validate_approval(approval, ACCOUNT)
        for change in [{'account': 'b' * 32}, {'classA': 900000}, {'classB': True},
                       {'storagePeakBytes': -1}, {'sourceSha256': ''}, {'checkedAt': '2020-01-01T00:00:00Z'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                remote.validate_approval({**approval, 'usageEvidence': {**evidence, **change}}, ACCOUNT)
