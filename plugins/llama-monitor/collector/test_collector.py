import importlib.util
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("collector","collector/collector.py")
collector=importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

class CollectorTests(unittest.TestCase):
    def test_missing_gpu_does_not_report_zero_vram(self):
        warnings=[]
        with patch.object(collector.glob,"glob",return_value=[]):
            values,cards=collector.gpu_stats(warnings)
        self.assertEqual(values,{})
        self.assertEqual(cards,[])
        self.assertTrue(warnings)

    def test_scope_cgroup_and_cpu(self):
        memory={"MemTotal":64000,"MemAvailable":32000,"SwapTotal":4000,"SwapFree":1000}
        with patch.object(collector,"cpu_ticks",side_effect=[(100,40),(200,80)]),patch.object(collector.time,"sleep"),patch.object(collector,"meminfo",return_value=memory),patch.object(collector,"read_number",side_effect=[32768,4000]),patch.object(collector,"gpu_stats",return_value=({},[])):
            out=collector.snapshot()
        self.assertEqual(out["host"]["cpuPercent"],60)
        self.assertEqual(out["host"]["ramAvailableBytes"],32000)
        self.assertEqual(out["host"]["containerLimitBytes"],32768)
        self.assertEqual(out["host"]["swapUsedBytes"],3000)
        self.assertNotIn("processRssBytes",out["host"])
        self.assertIn("namespace",out["scope"])

if __name__=="__main__":
    unittest.main()
