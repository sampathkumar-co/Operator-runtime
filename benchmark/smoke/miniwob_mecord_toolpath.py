import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"
base_url = os.environ["MINIWOB_URL"]
task_url = base_url + "click-test.html"

with sync_playwright() as pw:
    chromium = pw.chromium.executable_path

profile = tempfile.mkdtemp(prefix="mecord-benchmark-chromium-")
browser_proc = subprocess.Popen(
    [
        chromium,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        f"--user-data-dir={profile}",
        "about:blank",
    ],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

try:
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(CDP + "/json/version", timeout=1) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("Chromium CDP endpoint did not become ready.")

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(CDP)
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(task_url)
        page.evaluate(
            """() => {
              Math.seedrandom(0);
              core.EPISODE_MAX_TIME = 100000;
              core.startEpisodeReal();
            }"""
        )
        page.wait_for_function("() => WOB_TASK_READY === true", timeout=5000)
        goal = page.evaluate("() => core.getUtterance()")

        acted = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "benchmark/smoke/mecord_browser_click.ts",
                CDP,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )

        if acted.stdout:
            print("MECORD_ACTION=" + acted.stdout.strip())
        if acted.returncode != 0:
            raise RuntimeError(
                "Mecord browser provider failed: "
                + (acted.stderr.strip() or acted.stdout.strip())
            )

        score = page.evaluate(
            """() => ({
              rawReward: WOB_RAW_REWARD_GLOBAL,
              reward: WOB_REWARD_GLOBAL,
              done: WOB_DONE_GLOBAL,
              reason: WOB_REWARD_REASON
            })"""
        )

        result = {
            "ok": bool(score["rawReward"] > 0 and score["done"]),
            "classification": "mecord-tool-path-self-test",
            "notAModelAgentScore": True,
            "task": "miniwob.click-test",
            "goal": goal if isinstance(goal, str) else goal.get("utterance"),
            "rawReward": score["rawReward"],
            "reward": score["reward"],
            "done": score["done"],
            "reason": score["reason"],
        }
        print(json.dumps(result, sort_keys=True))

        if not result["ok"]:
            raise RuntimeError(f"Mecord MiniWoB tool-path self-test failed: {result}")

        browser.close()
finally:
    browser_proc.terminate()
    try:
        browser_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        browser_proc.kill()
        browser_proc.wait(timeout=5)
