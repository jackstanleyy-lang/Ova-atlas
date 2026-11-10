import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release_audit',HERE/'tools'/'release_audit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


def run(*args, cwd=None):
    return subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,check=True)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='atlas_test_')
        self.repo=Path(self.temp.name)/'repo';self.repo.mkdir()
        run('git','init','-b','main',cwd=self.repo)
        run('git','config','user.name','Atlas Test',cwd=self.repo)
        run('git','config','user.email','atlas@example.invalid',cwd=self.repo)
        run('git','remote','add','origin','https://github.com/jackstanleyy-lang/Ova-atlas.git',cwd=self.repo)
        import zipfile
        self.source=Path(self.temp.name)/'candidate.zip'
        with zipfile.ZipFile(self.source,'w') as z:
            for name in [*audit.SHELL,'tests/atlas-integrity.test.mjs']:
                z.write(HERE/name,name)
        with zipfile.ZipFile(self.source) as z:
            z.extractall(self.repo)
        run('git','add','.',cwd=self.repo)
        run('git','commit','-m','test v8.8 baseline',cwd=self.repo)
    def tearDown(self):self.temp.cleanup()

    def test_exact_match_reports_release_ready_and_does_not_edit_repo(self):
        before=run('git','status','--porcelain',cwd=self.repo).stdout
        result=audit.audit(self.repo,self.source)
        self.assertEqual(result['blockers'],[],result['blockers'])
        self.assertTrue(all(f['status']=='same' for f in result['file_comparison']))
        self.assertIn('matches checked-out',result['next_action'])
        self.assertEqual(before,run('git','status','--porcelain',cwd=self.repo).stdout)
    def test_remote_ui_difference_forces_manual_merge(self):
        f=self.repo/'index.html';f.write_text(f.read_text().replace('id="duplicate-scan"','id="remote-variant"'))
        run('git','add','.',cwd=self.repo);run('git','commit','-m','remote feature changed',cwd=self.repo)
        result=audit.audit(self.repo,self.source)
        self.assertEqual(result['git']['clean'],True)
        self.assertIn('MANUAL MERGE',result['next_action'])
        self.assertEqual(result['feature_matrix']['exact_copy_review']['repository'],False)
    def test_private_asset_flags_public_release_blocker(self):
        f=self.repo/'index.html';f.write_text(f.read_text()+ '\nconst secret="libfile_0123456789abcdef";\n')
        run('git','add','.',cwd=self.repo);run('git','commit','-m','add leaked metadata',cwd=self.repo)
        result=audit.audit(self.repo,self.source)
        self.assertIn('private Library identifier embedded',result['repository_risks'])
        self.assertTrue(result['blockers'])
    def test_wrong_origin_blocks(self):
        run('git','remote','set-url','origin','https://github.com/wrong/repository.git',cwd=self.repo)
        result=audit.audit(self.repo,self.source)
        self.assertTrue(any('origin' in s for s in result['blockers']))
    def test_dirty_worktree_blocks(self):
        (self.repo/'README.md').write_text('changed locally')
        result=audit.audit(self.repo,self.source)
        self.assertIn('Local working tree has uncommitted changes',result['blockers'])

if __name__=='__main__':unittest.main()
