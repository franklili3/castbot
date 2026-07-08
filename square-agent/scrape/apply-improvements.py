#!/usr/bin/env python3
"""
自动执行分析报告中的改进方案

读取 latest-analysis.json，将改进建议转化为具体行动：
1. 标题质量规则 → 写入 learned-rules.json（pipeline 下次生成时参考）
2. 低浏览量/重复帖子 → 推送 Telegram 删除建议（人工确认）
3. 内容策略调整 → 更新 learned-rules.json

在 analyze-square.py 之后运行。
"""

import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime
import requests

DATA_DIR = Path("/home/frank/clawd/square-agent/data")
REPORT_DIR = DATA_DIR / "reports"
RULES_FILE = DATA_DIR / "learned-rules.json"

# .env
_env = Path("/home/frank/clawd/square-agent/.env")
if _env.exists():
    for line in _env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
GLM_API_KEY = os.environ.get("NEWS_ZHIPU_API_KEY", "")
GLM_BASE = os.environ.get("NEWS_ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")
GLM_MODEL = os.environ.get("NEWS_ZHIPU_MODEL", "glm-4-flash-250414")


def load_rules():
    if RULES_FILE.exists():
        return json.loads(RULES_FILE.read_text())
    return {
        "updatedAt": "",
        "titleRules": [],
        "contentRules": [],
        "topicPreferences": {},
        "lowPerfPatterns": [],
        "stats": {"totalAlerts": 0, "totalActions": 0},
    }


def save_rules(rules):
    rules["updatedAt"] = datetime.now().isoformat()
    RULES_FILE.write_text(json.dumps(rules, indent=2, ensure_ascii=False))


def call_glm(prompt, system="你是币安广场内容优化引擎。"):
    if not GLM_API_KEY:
        return ""
    try:
        resp = requests.post(
            f"{GLM_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {GLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GLM_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 1500,
                "temperature": 0.3,
            },
            timeout=30,
        )
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"⚠️ GLM 调用失败: {e}")
        return ""


def send_telegram(text):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("⚠️ Telegram 未配置，跳过推送")
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={
                "chat_id": CHAT_ID,
                "text": text,
                "parse_mode": "HTML",
            },
            timeout=15,
        )
        return resp.status_code == 200
    except Exception as e:
        print(f"⚠️ Telegram 推送失败: {e}")
        return False


def extract_actionable_rules(analysis_json):
    """从分析报告中提取可执行规则"""
    rules = load_rules()
    alerts = analysis_json.get("alerts", [])
    actions_taken = []

    for alert in alerts:
        atype = alert.get("type")
        improvements = alert.get("improvements", "")

        if atype == "LOW_VIEWS":
            # 提取低浏览量帖子的模式
            for post in alert.get("posts", []):
                pattern = {
                    "title": post.get("title", "")[:80],
                    "views": post.get("views", 0),
                    "source": post.get("source", ""),
                    "titleScore": post.get("title_score", 0),
                    "detectedAt": datetime.now().strftime("%Y-%m-%d"),
                }
                # 避免重复记录相同标题
                existing = [p for p in rules["lowPerfPatterns"] if p["title"] == pattern["title"]]
                if not existing:
                    rules["lowPerfPatterns"].append(pattern)
                    actions_taken.append(f"记录低表现帖子: {pattern['title'][:40]}... (浏览{pattern['views']})")

            # 从 LLM 改进建议中提取标题规则
            if improvements:
                # 用 LLM 将建议转化为结构化规则
                rule_prompt = f"""基于以下币安广场内容分析，提取 2-3 条可执行的内容生成规则。
要求：简洁、具体、可直接用于指导下次内容生成。

分析报告改进建议:
{improvements[:1500]}

输出 JSON 格式：
{{
  "titleRules": ["规则1", "规则2"],
  "contentRules": ["规则1"],
  "topicShifts": {{"鼓励": ["话题1"], "减少": ["话题1"]}}
}}
只输出 JSON，不要解释。"""

                llm_response = call_glm(rule_prompt)
                if llm_response:
                    try:
                        # 清理 markdown 包裹
                        clean = re.sub(r'^```json\s*', '', llm_response.strip(), flags=re.M)
                        clean = re.sub(r'\s*```$', '', clean.strip())
                        extracted = json.loads(clean)

                        for r in extracted.get("titleRules", []):
                            if r and r not in rules["titleRules"]:
                                rules["titleRules"].append(r)
                                actions_taken.append(f"新标题规则: {r[:50]}")

                        for r in extracted.get("contentRules", []):
                            if r and r not in rules["contentRules"]:
                                rules["contentRules"].append(r)
                                actions_taken.append(f"新内容规则: {r[:50]}")

                        shifts = extracted.get("topicShifts", {})
                        for topic in shifts.get("鼓励", []):
                            rules["topicPreferences"][topic] = "encourage"
                        for topic in shifts.get("减少", []):
                            rules["topicPreferences"][topic] = "discourage"

                    except json.JSONDecodeError:
                        print("⚠️ LLM 规则提取失败（JSON解析）")

        elif atype == "DUPLICATE_CONTENT":
            # 重复内容 → 记录去重规则
            for group in alert.get("groups", []):
                topic = group.get("topic", "")
                if topic:
                    rule = f"避免短时间内重复发布「{topic}」相关内容"
                    if rule not in rules["contentRules"]:
                        rules["contentRules"].append(rule)
                        actions_taken.append(f"去重规则: {rule[:50]}")

        elif atype == "DRAFT_VIOLATION":
            # 草稿违规 → 基于比较分析（drafts[].comparativeFindings）提取【具体】规则
            #
            # 关键约束：不能添加「避免价格预测/交易信号」这类泛泛规则——
            # 大量已发布帖子证明这些本身是允许的。
            # 只记录基于【对照证据】的具体模式。
            findings = alert.get("comparativeFindings", [])
            drafts_meta = {i: d for i, d in enumerate(alert.get("drafts", []), 1)}

            for finding in findings:
                draft_idx = finding.get("draftIndex")
                draft = drafts_meta.get(draft_idx, {})
                draft_title = (draft.get("title", "") or "")[:50]

                for feat in finding.get("distinguishingFeatures", [])[:3]:
                    feature = (feat.get("feature", "") or "").strip()
                    evidence = (feat.get("draftEvidence", "") or "").strip()
                    comp = (feat.get("comparisonEvidence", "") or "").strip()
                    suggestion = (feat.get("fixSuggestion", "") or "").strip()

                    if not feature:
                        continue

                    # 规则文本必须包含【草稿证据 + 对照证据】，避免泛化
                    rule_text = (
                        f"违规特征「{feature}」: 草稿出现「{evidence[:60]}」，"
                        f"但对照帖【{comp[:50]}】未犯；修改: {suggestion[:60]}"
                    )

                    if rule_text not in rules["contentRules"]:
                        rules["contentRules"].append(rule_text)
                        actions_taken.append(
                            f"草稿违规规则(基于比较): {feature[:30]} (草稿#{draft_idx} {draft_title[:30]})"
                        )

            # 推送 Telegram（HIGH 严重度，必须人工 review）
            tg_msg = _build_draft_violation_tg(alert)
            if tg_msg:
                if send_telegram(tg_msg):
                    actions_taken.append("DRAFT_VIOLATION Telegram 推送完成")
                else:
                    actions_taken.append("DRAFT_VIOLATION Telegram 推送失败（已记录规则）")

    # 限制历史记录长度
    rules["lowPerfPatterns"] = rules["lowPerfPatterns"][-50:]

    # 更新统计
    rules["stats"]["totalAlerts"] += len(alerts)
    rules["stats"]["totalActions"] += len(actions_taken)

    return rules, actions_taken


def _build_draft_violation_tg(alert: dict) -> str:
    """构造 DRAFT_VIOLATION 的 Telegram 消息。

    关键设计：消息必须展示【比较得出的具体差异】，不能是「删除交易信号」这种泛泛建议。
    每个草稿最多 3 条 distinguishingFeatures。
    """
    findings = alert.get("comparativeFindings", [])
    drafts = alert.get("drafts", [])
    comp_count = alert.get("comparisonPostCount", 0)

    if not drafts:
        return ""

    lines = [
        f"🚫 <b>DRAFT_VIOLATION 告警</b> ({alert.get('draftCount', 0)} 篇草稿被拦截)",
        f"<i>基于 {comp_count} 篇对照帖比较分析（对照帖含价格预测但通过审核）</i>",
        "",
    ]

    # 用 draftIndex 索引 drafts
    drafts_by_idx = {i: d for i, d in enumerate(drafts, 1)}
    findings_by_idx = {}
    for f in findings:
        findings_by_idx.setdefault(f.get("draftIndex"), []).append(f)

    for idx, draft in drafts_by_idx.items():
        title = (draft.get("title", "") or "")[:60]
        violation = (draft.get("violation", "") or "未提供")[:80]
        lines.append(f"<b>草稿 #{idx}</b>: {title}")
        lines.append(f"  违规提示: <i>{violation}</i>")

        draft_findings = findings_by_idx.get(idx, [])
        if not draft_findings:
            # 没有结构化 findings（LLM 解析失败或超时）→ 提示人工查看
            lines.append("  ⚠️ 比较分析未生成，请人工查看 latest-analysis.json")
        else:
            for finding in draft_findings:
                for j, feat in enumerate(finding.get("distinguishingFeatures", [])[:3], 1):
                    feature = (feat.get("feature", "") or "")[:40]
                    evidence = (feat.get("draftEvidence", "") or "")[:80]
                    suggestion = (feat.get("fixSuggestion", "") or "")[:80]
                    lines.append(f"  {j}. <b>{feature}</b>")
                    lines.append(f"     草稿: <code>{evidence}</code>")
                    lines.append(f"     建议: {suggestion}")
                risk = finding.get("rejectionRisk", "")
                if risk:
                    lines.append(f"  📊 重新发布风险: {risk}")
        lines.append("")

    lines.append("<i>人工 review 后再修改/重发，不自动删除</i>")
    return "\n".join(lines)


def generate_deletion_suggestions(analysis_json):
    """生成低表现帖子删除建议"""
    suggestions = []
    for alert in analysis_json.get("alerts", []):
        if alert.get("type") == "LOW_VIEWS":
            for post in alert.get("posts", []):
                views = post.get("views", 0)
                if views < 10:
                    suggestions.append({
                        "title": post.get("title", ""),
                        "views": views,
                        "reason": f"浏览量极低({views})，建议删除以保持账号质量",
                    })
        elif alert.get("type") == "DUPLICATE_CONTENT":
            for group in alert.get("groups", []):
                posts = group.get("posts", [])
                # 保留浏览量最高的，建议删除其他
                if len(posts) > 1:
                    sorted_posts = sorted(posts, key=lambda x: x.get("views", 0), reverse=True)
                    for p in sorted_posts[1:]:
                        suggestions.append({
                            "title": p.get("title", ""),
                            "views": p.get("views", 0),
                            "reason": f"与「{group.get('topic', '')}」重复，保留浏览最高的帖子",
                        })
    return suggestions


def main():
    latest = REPORT_DIR / "latest-analysis.json"
    if not latest.exists():
        print("❌ latest-analysis.json 不存在")
        sys.exit(1)

    analysis = json.loads(latest.read_text())
    alerts = analysis.get("alerts", [])

    if not alerts:
        print("✅ 无告警，无需改进")
        return

    print(f"📋 处理 {len(alerts)} 个告警...")

    # 1. 提取规则
    rules, actions = extract_actionable_rules(analysis)
    save_rules(rules)

    for a in actions:
        print(f"  ✅ {a}")

    # 2. 删除建议
    suggestions = generate_deletion_suggestions(analysis)

    if suggestions:
        print(f"\n📤 {len(suggestions)} 条删除建议 → Telegram")
        # 推送 Telegram
        msg_lines = ["🗑️ <b>低表现帖子清理建议</b>", ""]
        for i, s in enumerate(suggestions[:5], 1):
            msg_lines.append(f"{i}. <b>{s['title'][:50]}</b>")
            msg_lines.append(f"   浏览: {s['views']} | {s['reason']}")
            msg_lines.append("")

        msg_lines.append(f"<i>共 {len(suggestions)} 条，登录 Creator Center 手动处理</i>")
        send_telegram("\n".join(msg_lines))
        print("  ✅ Telegram 推送完成")

    # 3. 汇总
    rules_summary = []
    if rules["titleRules"]:
        rules_summary.append(f"标题规则: {len(rules['titleRules'])} 条")
    if rules["contentRules"]:
        rules_summary.append(f"内容规则: {len(rules['contentRules'])} 条")
    if rules["topicPreferences"]:
        rules_summary.append(f"话题偏好: {len(rules['topicPreferences'])} 个")
    if rules["lowPerfPatterns"]:
        rules_summary.append(f"低表现记录: {len(rules['lowPerfPatterns'])} 条")

    if rules_summary:
        print(f"\n📚 Learned Rules 更新: {' | '.join(rules_summary)}")
        print(f"   文件: {RULES_FILE}")

    if not actions and not suggestions:
        print("✅ 无需执行的操作")


if __name__ == "__main__":
    main()
