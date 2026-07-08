#!/usr/bin/env python3
"""
Binance Square Profile 数据分析引擎

功能:
1. 解析 profile 页面帖子数据
2. 与上次采集对比(浏览量变化)
3. 低浏览量帖子检测 + 根因分析
4. 内容重复检测
5. 标题质量评分
6. 输出改进建议

数据源:scrape-local-uc.py 输出的 profile-latest.json + 历史 profile-*.json
"""

import json
import os
import sys
import re
from pathlib import Path
from datetime import datetime
from difflib import SequenceMatcher

DATA_DIR = Path("/home/frank/clawd/square-agent/data")
REPORT_DIR = DATA_DIR / "reports"
REPORT_DIR.mkdir(parents=True, exist_ok=True)

# Stats file paths (each is a dict with pageText/apiData/scrapedAt)
BUZZ_STATS_PATH = DATA_DIR / "content-buzz-stats.json"
DRAFT_STATS_PATH = DATA_DIR / "draft-stats.json"
REMOVED_STATS_PATH = DATA_DIR / "removed-stats.json"
CREATOR_HOME_STATS_PATH = DATA_DIR / "creator-home-stats.json"


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv(Path("/home/frank/clawd/square-agent/.env"))

API_KEY = os.environ.get("NEWS_ZHIPU_API_KEY") or os.environ.get("ZHIPU_API_KEY", "")
API_URL = os.environ.get("NEWS_ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4") + "/chat/completions"
MODEL = os.environ.get("NEWS_ZHIPU_MODEL", "glm-4-flash")


def call_llm(prompt: str, system: str = "") -> str:
    if not API_KEY:
        return "[LLM 未配置:缺少 ZHIPU_API_KEY]"
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    import requests
    try:
        resp = requests.post(API_URL, headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        }, json={"model": MODEL, "messages": messages, "max_tokens": 2000, "temperature": 0.7}, timeout=30)
    except Exception as e:
        return f"[LLM调用失败] {type(e).__name__}: {str(e)[:200]}"

    try:
        data = resp.json()
    except Exception:
        return f"[LLM返回非JSON] HTTP {resp.status_code}: {resp.text[:200]}"

    if "error" in data:
        return f"[LLM错误] {data['error']}"
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        return f"[LLM响应格式异常] {str(data)[:200]}"


def _find_duplicate_topics(posts: list, min_minutes: int = 10) -> list:
    """检测短时间内同一话题的多篇帖子"""
    duplicates = []
    seen = set()  # (topic, pub1, pub2)

    for i, p1 in enumerate(posts):
        for j, p2 in enumerate(posts):
            if j <= i:
                continue
            t1 = p1.get("published_at")
            t2 = p2.get("published_at")
            if not t1 or not t2:
                continue
            try:
                dt1 = datetime.strptime(t1, "%Y-%m-%d %H:%M")
                dt2 = datetime.strptime(t2, "%Y-%m-%d %H:%M")
            except ValueError:
                continue

            if abs((dt1 - dt2).total_seconds() / 60) > min_minutes:
                continue

            title1 = p1.get("title", "")
            title2 = p2.get("title", "")
            preview1 = p1.get("preview", "")
            preview2 = p2.get("preview", "")

            title_sim = SequenceMatcher(None, title1, title2).ratio()
            kw1 = set(re.findall(r'[A-Z]{3,}|\$\w+|#\w+', preview1))
            kw2 = set(re.findall(r'[A-Z]{3,}|\$\w+|#\w+', preview2))
            kw_overlap = len(kw1 & kw2) / max(len(kw1 | kw2), 1)

            if title_sim > 0.4 or kw_overlap > 0.5:
                common_kw = sorted(kw1 & kw2)
                topic = " + ".join(common_kw[:3]) if common_kw else f"话题{i}"
                key = (topic, p1.get("published_at"), p2.get("published_at"))
                if key not in seen:
                    seen.add(key)
                    found = False
                    for t, posts_list in duplicates:
                        if t == topic:
                            if p1.get("published_at") not in [pp.get("published_at") for pp in posts_list]:
                                posts_list.append(p1)
                            if p2.get("published_at") not in [pp.get("published_at") for pp in posts_list]:
                                posts_list.append(p2)
                            found = True
                            break
                    if not found:
                        duplicates.append((topic, [p1, p2]))

    return [(t, pl) for t, pl in duplicates if len(pl) >= 2]


def _score_title(title: str) -> int:
    """标题质量评分 0-100"""
    if not title:
        return 0
    score = 0
    if re.search(r'\d+\s*[枚个个]\s*BTC', title): score += 20
    if re.search(r'\$[\d.]+[KMB]?', title): score += 20
    if any(w in title for w in ["涨", "跌", "突破", "跌破", "暴涨", "暴跌", "利好", "利空"]): score += 15
    if any(w in title for w in ["Strategy", "ETF", "美联储", "SEC", "BlackRock"]): score += 15
    if 40 <= len(title) <= 80: score += 15
    if any(w in title for w in ["historic", "撑腰"]): score -= 15
    return max(0, min(100, score))


def parse_profile(text: str) -> dict:
    """从 profile 页面文本解析帖子列表

    profile 页面结构：
    - 顶部：账号名、粉丝、关注、获赞
    - 帖子格式：CryptoQClaw · X时间\n[标题]\n[内容]\n[标签]\n查看更多\nBTC +0.73%\nETH +0.85%\n[浏览量]\n...
    """
    posts = []
    
    # 顶部信息
    info = {}
    followers_m = re.search(r'(\d+)\s*\n\s*粉丝', text[:500])
    if followers_m: info["followers"] = int(followers_m.group(1))
    following_m = re.search(r'(\d+)\s*\n\s*关注', text[:500])
    if following_m: info["following"] = int(following_m.group(1))
    likes_m = re.search(r'(\d+)\s*\n\s*获赞', text[:500])
    if likes_m: info["total_likes"] = int(likes_m.group(1))
    total_m = re.search(r'(\d[\d.]*k?)\s*个内容', text[:500])
    if total_m: info["total_posts"] = total_m.group(1)
    
    # 用 "CryptoQClaw\n·\nX时间" 分割帖子
    # 每个帖子以 "CryptoQClaw\n·\n" 开头
    post_blocks = re.split(r'CryptoQClaw\n·\n', text)
    
    for block in post_blocks[1:]:
        post = {}
        
        # 相对时间（在块开头）
        time_m = re.match(r'(\d+\s*(?:小时|分钟|天|周))', block)
        if time_m:
            post["published_at_relative"] = time_m.group(1)
            # 转换为近似的绝对时间
            post["sort_key"] = _relative_time_sort(time_m.group(1))
        else:
            # 可能是绝对时间
            abs_time = re.match(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})', block)
            if abs_time:
                post["published_at"] = abs_time.group(1)
                post["sort_key"] = 0
        
        # 浏览量（在帖子末尾，块末尾的纯数字行）
        # profile 页面浏览量是帖子最后一行数字（在 "查看更多" 之后）
        lines = block.strip().split("\n")
        if lines:
            # 倒数几行找纯数字（浏览量）
            for line in reversed(lines[-5:]):
                line_stripped = line.strip()
                if line_stripped.isdigit() and int(line_stripped) > 0:
                    # 排除价格变化行（如 +0.73%）
                    if not re.match(r'[+-]?[\d.]+%', line_stripped):
                        post["views"] = int(line_stripped)
                        break
        
        # 标题（📰 开头或 🔍 开头）
        title_m = re.search(r'([📰🔍][^\n]+)', block)
        if title_m:
            post["title"] = title_m.group(1).strip()[:120]
        else:
            # 第一行非空非时间的内容
            for line in lines[1:3]:
                if line.strip() and not re.match(r'\d+\s*(小时|分钟|天|周)', line.strip()):
                    post["title"] = line.strip()[:120]
                    break
        
        # 内容预览
        content = block.replace("\n", " ").strip()
        post["preview"] = content[:500]
        
        # 标签
        tags = re.findall(r'(#[A-Za-z0-9_]+)', block)
        if tags:
            post["tags"] = list(set(tags))
        
        # 预判编号
        pred_m = re.search(r'第(\d+)次预判', block)
        if pred_m:
            post["prediction_num"] = int(pred_m.group(1))
        
        # 来源
        source_m = re.search(r'新闻时间：([\w.]+)', block)
        if source_m:
            post["source"] = source_m.group(1)
        
        # 预判方向
        if "利多" in block or "看涨" in block or "预测涨" in block:
            post["direction"] = "bullish"
        elif "利空" in block or "看跌" in block or "预测跌" in block:
            post["direction"] = "bearish"
        elif "中性" in block:
            post["direction"] = "neutral"
        
        if post.get("views") is not None:
            posts.append(post)
    
    return {"info": info, "posts": posts}


def _relative_time_sort(relative: str) -> int:
    """将相对时间转为排序用分钟数（越小越新）"""
    m = re.match(r'(\d+)\s*(小时|分钟|天|周)', relative)
    if not m:
        return 99999
    n = int(m.group(1))
    unit = m.group(2)
    if unit == "分钟": return n
    if unit == "小时": return n * 60
    if unit == "天": return n * 1440
    if unit == "周": return n * 10080
    return 99999


def get_previous_snapshot() -> dict | None:
    """获取上一次的历史快照(用于对比浏览量变化)"""
    snapshots = sorted(DATA_DIR.glob("profile-*.json"))
    if not snapshots:
        return None
    # 排除最新的(那是刚采集的),取倒数第二
    # 但如果 latest 是我们刚写的,历史里应该有上一个
    try:
        return json.loads(snapshots[-2].read_text()) if len(snapshots) >= 2 else None
    except Exception:
        return None


def compare_with_previous(current_posts, previous_posts) -> list:
    """对比两次采集的浏览量变化"""
    changes = []
    prev_by_time = {p.get("published_at"): p for p in previous_posts if p.get("published_at")}

    for post in current_posts:
        pub = post.get("published_at")
        if not pub or pub not in prev_by_time:
            continue
        prev = prev_by_time[pub]
        prev_views = prev.get("views", 0)
        curr_views = post.get("views", 0)
        delta = curr_views - prev_views
        if delta != 0:
            changes.append({
                "title": post.get("title", "")[:80],
                "published_at": pub,
                "prev_views": prev_views,
                "curr_views": curr_views,
                "delta": delta,
            })

    return sorted(changes, key=lambda x: x["delta"])


def analyze(posts: list, info: dict, prev_changes: list | None = None) -> dict:
    """主分析逻辑"""
    alerts = []

    # === 1. 低浏览量检测 ===
    low_view_posts = []
    for post in posts:
        rel = post.get("published_at_relative")
        views = post.get("views", 0)
        if not rel:
            continue
        sort_min = post.get("sort_key", 99999)
        # 发布超过30分钟且浏览量低于阈值
        if sort_min >= 30 and views < 50:
            low_view_posts.append(post)

    if low_view_posts:
        duplicates = _find_duplicate_topics(posts)
        title_scores = {p.get("published_at"): _score_title(p.get("title", "")) for p in low_view_posts}

        posts_text = "\n".join([
            f"- [{p.get('published_at')}] {p.get('title','')[:80]} | 浏览:{p.get('views',0)} | 来源:{p.get('source','?')} | 标题分:{title_scores.get(p.get('published_at'),0)}"
            for p in low_view_posts[:8]
        ])

        dup_text = ""
        if duplicates:
            for topic, dups in duplicates[:3]:
                sorted_dups = sorted(dups, key=lambda x: x.get("views", 0), reverse=True)
                dup_text += f"\n话题「{topic}」:\n"
                for d in sorted_dups:
                    dup_text += f"  浏览{d.get('views',0)} | {d.get('published_at','')} | {d.get('title','')[:60]}\n"

        prev_text = ""
        if prev_changes:
            prev_text = "\n\n**最近30分钟浏览量变化:**\n"
            prev_text += "\n".join([
                f"  {c['delta']:+d} → {c['curr_views']}浏览 | {c['title'][:60]}"
                for c in prev_changes[:5]
            ])

        prompt = f"""你是币安广场内容运营专家。分析以下帖子数据,给出改进建议。

**账号信息:** 粉丝 {info.get('followers','?')} | 总帖子 {info.get('total_posts','?')}

**低浏览量帖子(发布30+分钟,浏览<50):**
{posts_text}
{dup_text if dup_text else ''}{prev_text if prev_text else ''}

请分析并输出:
1. 浏览量低的根本原因(重点:内容重复、标题质量、发布时间、话题选择)
2. 如有重复发帖,分析影响和应对策略
3. 标题优化建议(用 BTC 数量/价格作锚点数字)
4. 3-5 条具体可执行的改进方案(按优先级排序)
5. 预期效果(每条改进方案预计提升多少浏览量)

用中文,简洁直接。"""

        analysis = call_llm(prompt, system="你是社交媒体内容优化专家,擅长提升帖子曝光和互动。深入理解币安广场推荐机制。")

        alerts.append({
            "type": "LOW_VIEWS",
            "severity": "MEDIUM",
            "message": f"{len(low_view_posts)} 篇帖子发布30+分钟浏览<50",
            "posts": [{
                "title": p.get("title", "")[:80],
                "views": p.get("views", 0),
                "published_at": p.get("published_at"),
                "source": p.get("source", "?"),
                "title_score": title_scores.get(p.get("published_at"), 0),
            } for p in low_view_posts],
            "improvements": analysis,
        })

    # === 2. 内容重复告警 ===
    duplicates = _find_duplicate_topics(posts)
    if duplicates:
        dup_count = sum(len(pl) for _, pl in duplicates)
        alerts.append({
            "type": "DUPLICATE_CONTENT",
            "severity": "HIGH",
            "message": f"检测到 {len(duplicates)} 组重复话题,共 {dup_count} 篇帖子",
            "groups": [{
                "topic": topic,
                "posts": [{"title": p.get("title", "")[:60], "views": p.get("views", 0), "published_at": p.get("published_at")} for p in pl]
            } for topic, pl in duplicates],
        })

    # === 3. 浏览量增长异常(比上次减少) ===
    if prev_changes:
        declining = [c for c in prev_changes if c["delta"] < 0]
        if len(declining) >= 3:
            alerts.append({
                "type": "DECLINING_VIEWS",
                "severity": "LOW",
                "message": f"{len(declining)} 篇帖子浏览量比上次采集下降",
                "changes": [{"title": c["title"], "delta": c["delta"]} for c in declining[:5]],
            })

    return alerts


def _load_stats(path: Path) -> dict | None:
    """安全加载 stats json。文件缺失或格式错误时返回 None 并告警。"""
    if not path.exists():
        print(f"⚠️ {path.name} 不存在，跳过该数据源")
        return None
    try:
        return json.loads(path.read_text())
    except Exception as e:
        print(f"⚠️ {path.name} 解析失败：{e}")
        return None


def parse_buzz_counts(text: str) -> dict:
    """从任意包含「已发布 (N)草稿 (N)已下架 (N)」的页面文本中提取计数。

    比 regex 解析单页更可靠：可从 buzz/draft/removed/home 任一 pageText 提取。
    """
    m = re.search(r'已发布\s*\((\d+)\)\s*草稿\s*\((\d+)\)\s*已下架\s*\((\d+)\)', text or "")
    if not m:
        return {"published": None, "draft": None, "removed": None}
    return {
        "published": int(m.group(1)),
        "draft": int(m.group(2)),
        "removed": int(m.group(3)),
    }


def parse_draft_posts(text: str) -> list[dict]:
    """从草稿页 pageText 提取每篇草稿的结构化信息。

    草稿页结构（每篇草稿）：
        [post body...]
        [tags like $BTC #BTC]
        # [author handle e.g. Coinbase]
        2026-07-07 22:05草稿
        您的发帖未遵守我们的社区管理准则  ← violation notice (可选)
        [N]  ← 点赞/阅读数

    返回每篇草稿: {body, tags, author, publish_time, violation, stats_line}
    """
    if not text:
        return []

    # 切掉「热门文章」之后的内容（不属于草稿列表）
    text = text.split("热门文章")[0]

    # 草稿块以 "YYYY-MM-DD HH:MM草稿" 为锚点向上回溯内容
    # 但页面顶部有导航/计数行，先去掉
    # 找到计数行后的内容起点
    cm = re.search(r'已发布\s*\(\d+\)\s*草稿\s*\(\d+\)\s*已下架\s*\(\d+\)', text)
    body_text = text[cm.end():] if cm else text

    drafts = []
    # 按 "YYYY-MM-DD HH:MM草稿" 分块
    blocks = re.split(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}草稿)', body_text)
    # blocks 形如 [pre, time1, middle1, time2, middle2, ...]
    if len(blocks) < 3:
        return []

    i = 1
    while i + 1 < len(blocks):
        time_str = blocks[i].replace("草稿", "").strip()
        # 块内容是 blocks[i-1]（在 time 之前的）+ blocks[i+1]（在 time 之后的，含 violation notice）
        before = blocks[i - 1] or ""
        after = blocks[i + 1] or ""
        # 草稿正文在 before 里（去掉上一个草稿的尾巴）
        # 取 before 最后一个非空段落
        before_clean = before.strip()
        # 草稿正文可能跨多行；裁掉空行
        body_lines = [ln for ln in before_clean.split("\n") if ln.strip()]
        # 去掉可能是上一个草稿 violation/stats 的尾巴（行如纯数字、"您的发帖..."）
        # 简单处理：保留所有非空、非纯数字行作为正文
        body_lines = [ln for ln in body_lines if not re.fullmatch(r'\d+', ln.strip())]
        body = "\n".join(body_lines).strip()

        # violation 提示在 after 里
        violation = ""
        vm = re.search(r'(您的发帖[^\n]*|未遵守[^\n]*社区[^\n]*)', after)
        if vm:
            violation = vm.group(1).strip()

        # 标签 / 币种
        tags = list(set(re.findall(r'#[A-Za-z0-9_]+', body)))
        tickers = list(set(re.findall(r'\$[A-Za-z]+', body)))

        # 作者 handle (## 标题后的 # handle 行)
        author_m = re.search(r'#\s*([A-Za-z][A-Za-z0-9_]{2,})\s*$', body, re.MULTILINE)
        author = author_m.group(1) if author_m else ""

        # 标题：第一个📰后的内容，或正文第一行
        title = ""
        tm = re.search(r'📰\s*([^\n]+)', body)
        if tm:
            title = tm.group(1).strip()[:120]
        else:
            title = body_lines[0][:120] if body_lines else ""

        drafts.append({
            "title": title,
            "body": body[:1500],
            "tags": tags,
            "tickers": tickers,
            "author": author,
            "publish_time": time_str,
            "violation": violation,
        })
        i += 2

    return drafts


def parse_removed_posts(text: str) -> list[dict]:
    """从已下架页 pageText 提取每篇已下架帖子的信息。

    当前已下架页结构较简单：占位文字「已下架的内容会在此处展示」+ 热门文章列表。
    若未来 bapi 返回结构化数据，这里需扩展。
    """
    if not text:
        return []

    # 检测是否为空（占位）
    if "已下架的内容会在此处展示" in text:
        return []

    # 否则尝试用与 draft 类似的解析（保留兼容）
    return parse_draft_posts(text)


def analyze_drafts_detail(draft_data: dict) -> dict | None:
    """对每篇草稿调用 LLM，给出基于实际违规提示词的具体修改建议。

    输入：draft-stats.json 的完整 dict（含 pageText）
    返回：{count, drafts: [...], analysis: str} 或 None
    """
    if not draft_data:
        return None

    page_text = draft_data.get("pageText", "")
    drafts = parse_draft_posts(page_text)

    if not drafts:
        return {"count": 0, "drafts": [], "analysis": "（草稿页无可解析的草稿块）"}

    # 构造每个草稿的摘要给 LLM
    draft_summaries = []
    for i, d in enumerate(drafts, 1):
        violation = d.get("violation", "（无明显违规提示）")
        draft_summaries.append(
            f"--- 草稿 #{i} ---\n"
            f"标题: {d['title']}\n"
            f"发布时间: {d['publish_time']}\n"
            f"违规提示: {violation}\n"
            f"币种: {', '.join(d['tickers']) or '无'}\n"
            f"正文摘要:\n{d['body'][:600]}\n"
        )

    prompt = f"""你是币安广场内容审核与运营专家。以下是 {len(drafts)} 篇被审核拦截为草稿的帖子。
每篇都附带 Binance Square 实际显示的违规提示词（如「未遵守社区管理准则」）。

请基于【实际违规提示词】给出具体、可执行的修改方案，而不是泛泛而谈。

{chr(10).join(draft_summaries)}

输出格式（每篇草稿）：
### 草稿 #N 修改方案
- **违规性质判断**：（基于提示词判断：是敏感词、营销过度、价格预测违规、还是社区准则？）
- **3 条具体修改建议**：（每条都要指出原文哪一句/哪个词需要改、改成什么）
- **重新发布风险评估**：（高/中/低 + 理由）

最后给一段「整体规律总结」：这些草稿的共同问题是什么，未来如何避免。

用中文，简洁直接，不要空话。"""

    analysis = call_llm(
        prompt,
        system="你是币安广场内容审核专家，深谙平台违规判定逻辑。给出可落地的修改方案，避免泛泛而谈。",
    )

    return {
        "count": len(drafts),
        "scrapedAt": draft_data.get("scrapedAt", ""),
        "drafts": drafts,
        "analysis": analysis,
    }


def analyze_removed_detail(removed_data: dict) -> dict | None:
    """对已下架帖子做 post-mortem 分析。

    输入：removed-stats.json 的完整 dict
    返回：{count, posts: [...], analysis: str} 或 None
    """
    if not removed_data:
        return None

    page_text = removed_data.get("pageText", "")
    posts = parse_removed_posts(page_text)

    if not posts:
        return {
            "count": 0,
            "posts": [],
            "analysis": "（当前没有已下架的帖子，或页面仅显示占位文字）",
        }

    posts_summary = []
    for i, p in enumerate(posts, 1):
        posts_summary.append(
            f"--- 已下架 #{i} ---\n"
            f"标题: {p['title']}\n"
            f"原发布时间: {p['publish_time']}\n"
            f"正文摘要:\n{p['body'][:600]}\n"
        )

    prompt = f"""以下是 {len(posts)} 篇已被币安广场下架的帖子。请做 post-mortem 分析。

{chr(10).join(posts_summary)}

输出：
1. **下架原因推测**（按可能性排序，3 条以内）
2. **共性规律**（这些被下架帖子的共同特征：题材、措辞、币种、预测方式？）
3. **未来规避清单**（5 条具体规则，未来发帖时如何避免同类下架）

用中文，简洁直接。"""

    analysis = call_llm(
        prompt,
        system="你是币安广场内容审核与风控专家，擅长从下架案例中提炼可复用的规避规则。",
    )

    return {
        "count": len(posts),
        "scrapedAt": removed_data.get("scrapedAt", ""),
        "posts": posts,
        "analysis": analysis,
    }


def main():
    latest = DATA_DIR / "profile-latest.json"
    if not latest.exists():
        print("❌ profile-latest.json 不存在,请先运行采集脚本")
        sys.exit(1)

    raw = json.loads(latest.read_text())
    text = raw.get("pageText", "")

    if not text or len(text) < 100:
        print("❌ 页面文本为空或过短,采集可能失败")
        print(f"  charCount: {raw.get('charCount', 0)}")
        sys.exit(1)

    # 解析
    data = parse_profile(text)
    info = data["info"]
    posts = data["posts"]

    print(f"📊 解析: 粉丝 {info.get('followers','?')} | 帖子 {len(posts)} | 文本 {len(text)} chars")

    # 加载上次快照做对比
    prev_changes = None
    snapshots = sorted(DATA_DIR.glob("profile-*.json"))
    if len(snapshots) >= 2:
        try:
            prev_raw = json.loads(snapshots[-2].read_text())
            prev_data = parse_profile(prev_raw.get("pageText", ""))
            prev_changes = compare_with_previous(posts, prev_data["posts"])
            print(f"📈 对比上次: {len(prev_changes)} 篇有变化")
        except Exception as e:
            print(f"⚠️ 历史对比失败: {e}")

    # 分析
    alerts = analyze(posts, info, prev_changes)

    # 加载新数据源（缺失时优雅降级）
    buzz_stats = _load_stats(BUZZ_STATS_PATH)
    draft_stats = _load_stats(DRAFT_STATS_PATH)
    removed_stats = _load_stats(REMOVED_STATS_PATH)

    # 从最可靠的来源抽取计数（优先 buzz/draft/removed pageText，回退到 profile pageText）
    counts_sources = [buzz_stats, draft_stats, removed_stats]
    counts = {"published": None, "draft": None, "removed": None}
    for src in counts_sources:
        if not src:
            continue
        c = parse_buzz_counts(src.get("pageText", ""))
        for k in counts:
            if counts[k] is None and c.get(k) is not None:
                counts[k] = c[k]
    # 兜底：从 profile pageText
    if any(v is None for v in counts.values()):
        c2 = parse_buzz_counts(text)
        for k in counts:
            if counts[k] is None:
                counts[k] = c2.get(k)

    # 草稿计数告警（保留旧行为）
    if counts.get("draft") and counts["draft"] > 0:
        alerts.append({
            "type": "DRAFT_VIOLATION",
            "severity": "HIGH",
            "message": f"{counts['draft']} 篇草稿被审核拦截（含违规提示）",
            "draftCount": counts["draft"],
            "removedCount": counts.get("removed"),
        })

    # 草稿/已下架 per-post 详情分析
    drafts_detail = analyze_drafts_detail(draft_stats) if draft_stats else None
    removed_detail = analyze_removed_detail(removed_stats) if removed_stats else None

    # 报告
    report = {
        "analyzedAt": datetime.now().isoformat(),
        "scrapedAt": raw.get("scrapedAt", ""),
        "profileInfo": info,
        "postCount": len(posts),
        "buzzCounts": counts,
        "alerts": alerts,
        "prevChanges": [{"title": c["title"], "delta": c["delta"], "prev": c["prev_views"], "curr": c["curr_views"]} for c in (prev_changes or [])],
        "draftsDetail": drafts_detail,
        "removedDetail": removed_detail,
    }

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    (REPORT_DIR / f"analysis-{ts}.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    (REPORT_DIR / "latest-analysis.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    # Markdown
    md = _render_md(report)
    (REPORT_DIR / "latest-analysis.md").write_text(md)

    print(f"\n📄 报告: {REPORT_DIR / f'analysis-{ts}.json'}")

    if counts.get("draft") or counts.get("removed"):
        print(f"📦 内容计数: 已发布 {counts.get('published') or '?'} / 草稿 {counts.get('draft') or 0} / 已下架 {counts.get('removed') or 0}")

    for a in alerts:
        print(f"\n{'🚨' if a['severity']=='HIGH' else '⚠️'} [{a['type']}] {a['message']}")
        if "improvements" in a:
            print(a["improvements"][:500])

    if drafts_detail and drafts_detail.get("count"):
        print(f"\n📝 草稿详情（{drafts_detail['count']} 篇）：")
        for i, d in enumerate(drafts_detail.get("drafts", []), 1):
            v = d.get("violation", "")
            print(f"  #{i} {d.get('title','')[:60]} | {d.get('publish_time','')} | 违规: {v[:60]}")
        if drafts_detail.get("analysis"):
            print(f"\n🤖 草稿修改方案（节选）:\n{drafts_detail['analysis'][:600]}")

    if removed_detail and removed_detail.get("count"):
        print(f"\n🗑️ 已下架详情（{removed_detail['count']} 篇）：")
        for i, p in enumerate(removed_detail.get("posts", []), 1):
            print(f"  #{i} {p.get('title','')[:60]} | {p.get('publish_time','')}")

    return report


def _render_md(report: dict) -> str:
    info = report["profileInfo"]
    counts = report.get("buzzCounts") or {}
    lines = [
        f"# Binance Square 分析报告",
        "",
        f"- 分析时间:`{report['analyzedAt']}`",
        f"- 采集时间:`{report['scrapedAt']}`",
        f"- 粉丝:{info.get('followers','?')} | 总帖子:{info.get('total_posts','?')}",
        f"- 本次解析:{report['postCount']} 篇帖子",
        f"- 内容计数:已发布 {counts.get('published') or '?'} / 草稿 {counts.get('draft') or 0} / 已下架 {counts.get('removed') or 0}",
        "",
    ]

    if report.get("prevChanges"):
        lines += ["## 📈 浏览量变化", ""]
        for c in report["prevChanges"][:10]:
            emoji = "🟢" if c["delta"] > 0 else "🔴"
            lines.append(f"- {emoji} {c['delta']:+d} → {c['curr']}浏览 | {c['title'][:60]}")
        lines.append("")

    # 草稿详情
    dd = report.get("draftsDetail")
    if dd:
        lines += ["## 📝 草稿详情", ""]
        if dd.get("count", 0) == 0:
            lines += [f"_草稿数 0。{dd.get('analysis', '')}_", ""]
        else:
            lines += [f"共 {dd['count']} 篇草稿被审核拦截。每篇详情：", ""]
            for i, d in enumerate(dd.get("drafts", []), 1):
                lines += [
                    f"### 草稿 #{i} — {d.get('title','(无标题)')[:80]}",
                    "",
                    f"- 发布时间:`{d.get('publish_time','?')}`",
                    f"- 币种:{', '.join(d.get('tickers', [])) or '无'}",
                    f"- 标签:{', '.join(d.get('tags', [])) or '无'}",
                    f"- **违规提示**:{d.get('violation') or '（无明显提示）'}",
                    "",
                ]
            lines += ["### 🤖 LLM 修改方案", "", dd.get("analysis", ""), ""]

    # 已下架详情
    rd = report.get("removedDetail")
    if rd:
        lines += ["## 🗑️ 已下架详情", ""]
        if rd.get("count", 0) == 0:
            lines += [f"_已下架数 0。{rd.get('analysis', '')}_", ""]
        else:
            lines += [f"共 {rd['count']} 篇帖子被下架。每篇详情：", ""]
            for i, p in enumerate(rd.get("posts", []), 1):
                lines += [
                    f"### 已下架 #{i} — {p.get('title','(无标题)')[:80]}",
                    "",
                    f"- 原发布时间:`{p.get('publish_time','?')}`",
                    f"- 币种:{', '.join(p.get('tickers', [])) or '无'}",
                    "",
                ]
            lines += ["### 🤖 LLM Post-mortem", "", rd.get("analysis", ""), ""]

    if not report["alerts"]:
        lines += ["## ✅ 无告警", ""]
    else:
        lines.append("## 🚨 告警与改进")
        for a in report["alerts"]:
            lines += ["", f"### [{a['type']}] {a['severity']}", "", f"**{a['message']}**"]
            if "improvements" in a:
                lines += ["", "### 📋 改进方案", "", a["improvements"]]

    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
