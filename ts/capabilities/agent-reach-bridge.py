# -*- coding: utf-8 -*-
"""
agent-reach 通用反射桥(gotry wrapper 的唯一胶水)。

gotry 不持有任何渠道知识:渠道清单、方法清单、setup 指引全部来自上游
agent_reach 包(channel registry + Channel.check + guides)。

用法: python agent-reach-bridge.py <channel> <method> [args...]
退出码: 0=调用完成(看 JSON ok 字段) / 2=channel 或 method 不存在(附上游清单) / 3=调用抛错
"""

import importlib
import inspect
import json
import sys


def _public_methods(obj) -> dict:
    return {
        name: str(inspect.signature(getattr(obj, name)))
        for name in sorted(dir(obj))
        if not name.startswith("_") and callable(getattr(obj, name))
    }


def main() -> int:
    try:
        from agent_reach.channels import ALL_CHANNELS, get_channel
    except Exception as e:  # agent-reach 未装
        print(json.dumps({"ok": False, "error": f"agent_reach 未安装: {e}"}, ensure_ascii=False))
        return 3

    if len(sys.argv) < 3:
        print(json.dumps({
            "ok": False,
            "channels": {c.name: c.description for c in ALL_CHANNELS},
            "hint": "用法: bridge <channel> <method> [args...];渠道体检用 method=check",
        }, ensure_ascii=False))
        return 2

    channel_name, method_name = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]

    ch = get_channel(channel_name)
    if ch is None:
        print(json.dumps({
            "ok": False,
            "error": f"未知渠道 '{channel_name}'",
            "channels": {c.name: c.description for c in ALL_CHANNELS},
        }, ensure_ascii=False))
        return 2

    fn = getattr(ch, method_name, None)
    if fn is None or method_name.startswith("_") or not callable(fn):
        print(json.dumps({
            "ok": False,
            "error": f"渠道 '{channel_name}' 没有方法 '{method_name}'",
            "channel": {"name": ch.name, "description": ch.description, "tier": ch.tier, "backends": ch.backends},
            "methods": _public_methods(ch),
        }, ensure_ascii=False))
        return 2

    try:
        out = fn(*args)
        print(json.dumps({"ok": True, "data": out}, ensure_ascii=False, default=str))
        return 0
    except Exception as e:
        # 失败时带上上游自己的体检结论(check 返回 (status, message)),不自行转述
        check_status, check_msg = "unknown", ""
        try:
            check_status, check_msg = ch.check()
        except Exception:
            pass
        print(json.dumps({
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "check": {"status": check_status, "message": check_msg},
        }, ensure_ascii=False))
        return 3


if __name__ == "__main__":
    sys.exit(main())
