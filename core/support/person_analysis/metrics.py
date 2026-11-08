# -*- coding: utf-8 -*-
"""交流グラフの指標計算（純関数・表示時にギルドのグラフからその場で計算）。

入力は辺辞書 ``{発信者ID: {相手ID: 回数}}``（int キー）。保存形式
（store.py）からは独立させ、既知の小グラフで単体テストできるようにする。

判断メモ:
- PageRank は重み付き（辺の回数を遷移確率へ反映する）。damping 0.85。
- 媒介中心性は Brandes 法・**重みなし**・有向。重み付き最短路は「よく
  絡む相手ほど遠い」という逆向きの解釈になりやすいため、関係の有無
  だけで媒介性を測る。ノード数が ``BETWEENNESS_MAX_NODES`` を超える
  ギルドでは計算せず None を返し、表示側で「—」に落とす（負荷ガード）。
- クラスタは無向化した弱連結成分を規模順に C1, C2, … とラベルする。
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

DAMPING = 0.85
BETWEENNESS_MAX_NODES = 2000


def nodes_of(edges: dict[int, dict[int, int]]) -> set[int]:
    nodes: set[int] = set(edges)
    for outs in edges.values():
        nodes.update(outs)
    return nodes


def out_total(edges: dict[int, dict[int, int]], user_id: int) -> int:
    """送った（全期間）= 対象者の外向き辺の合計。"""
    return sum(edges.get(user_id, {}).values())


def in_total(edges: dict[int, dict[int, int]], user_id: int) -> int:
    """受け取った（全期間）= 対象者への内向き辺の合計。"""
    return sum(outs.get(user_id, 0) for outs in edges.values())


def pagerank(edges: dict[int, dict[int, int]], *, damping: float = DAMPING,
             tol: float = 1e-6, max_iter: int = 100) -> dict[int, float]:
    """重み付き PageRank。反復は辺走査のみ（O(辺数)/回）で収束させる。"""
    nodes = sorted(nodes_of(edges))
    n = len(nodes)
    if n == 0:
        return {}
    out_weight = {u: sum(edges.get(u, {}).values()) for u in nodes}
    rank = {u: 1.0 / n for u in nodes}
    base = (1.0 - damping) / n
    for _ in range(max_iter):
        dangling = sum(rank[u] for u in nodes if out_weight[u] == 0)
        new = {v: base + damping * dangling / n for v in nodes}
        for u in nodes:
            weight = out_weight[u]
            if weight == 0:
                continue
            share = damping * rank[u] / weight
            for v, w in edges.get(u, {}).items():
                new[v] += share * w
        delta = sum(abs(new[v] - rank[v]) for v in nodes)
        rank = new
        if delta < tol:
            break
    return rank


def betweenness(edges: dict[int, dict[int, int]], *,
                max_nodes: int = BETWEENNESS_MAX_NODES) -> dict[int, float] | None:
    """媒介中心性（Brandes・重みなし・有向、(n-1)(n-2) で正規化）。

    ノード数が上限を超える場合は None（表示側で「—」にする）。
    """
    nodes = nodes_of(edges)
    if len(nodes) > max_nodes:
        return None
    adjacency = {u: sorted(edges.get(u, {})) for u in nodes}
    centrality = {v: 0.0 for v in nodes}
    for s in sorted(nodes):
        stack: list[int] = []
        predecessors: dict[int, list[int]] = {w: [] for w in nodes}
        sigma = dict.fromkeys(nodes, 0)
        sigma[s] = 1
        dist = dict.fromkeys(nodes, -1)
        dist[s] = 0
        queue = deque([s])
        while queue:
            v = queue.popleft()
            stack.append(v)
            for w in adjacency.get(v, ()):
                if dist[w] < 0:
                    queue.append(w)
                    dist[w] = dist[v] + 1
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    predecessors[w].append(v)
        delta = dict.fromkeys(nodes, 0.0)
        while stack:
            w = stack.pop()
            for v in predecessors[w]:
                delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w])
            if w != s:
                centrality[w] += delta[w]
    n = len(nodes)
    if n > 2:
        scale = 1.0 / ((n - 1) * (n - 2))
        centrality = {v: c * scale for v, c in centrality.items()}
    return centrality


def components(edges: dict[int, dict[int, int]]) -> dict[int, tuple[str, int]]:
    """弱連結成分を規模順に C1, C2, … とラベルし {user: (ラベル, 人数)} を返す。"""
    undirected: dict[int, set[int]] = {}
    for src, outs in edges.items():
        undirected.setdefault(src, set())
        for dst in outs:
            undirected.setdefault(dst, set())
            undirected[src].add(dst)
            undirected[dst].add(src)
    seen: set[int] = set()
    groups: list[set[int]] = []
    for start in sorted(undirected):
        if start in seen:
            continue
        group: set[int] = set()
        stack = [start]
        seen.add(start)
        while stack:
            current = stack.pop()
            group.add(current)
            for neighbor in undirected[current]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        groups.append(group)
    groups.sort(key=lambda g: (-len(g), min(g)))
    result: dict[int, tuple[str, int]] = {}
    for index, group in enumerate(groups, start=1):
        for user_id in group:
            result[user_id] = (f"C{index}", len(group))
    return result


def top_partners(edges: dict[int, dict[int, int]], user_id: int,
                 limit: int = 6) -> list[tuple[int, int, int]]:
    """よく絡む相手を [(相手ID, 送った, 受けた), ...] で返す。

    双方向合計の多い順、同数なら送った数が多い順、最後は ID 順で安定させる。
    """
    partners: dict[int, list[int]] = {}
    for other, sent in edges.get(user_id, {}).items():
        if other != user_id:
            partners.setdefault(other, [0, 0])[0] = sent
    for other, outs in edges.items():
        if other == user_id:
            continue
        received = outs.get(user_id, 0)
        if received:
            partners.setdefault(other, [0, 0])[1] = received
    rows = [(other, counts[0], counts[1])
            for other, counts in partners.items()]
    rows.sort(key=lambda row: (-(row[1] + row[2]), -row[1], row[0]))
    return rows[:limit]


def peak_hours(hist: list[int] | None, limit: int = 3) -> list[int]:
    """ヒストグラムから発言の多い時間帯を順に最大 limit 個返す。"""
    indexed = [(count, hour) for hour, count in enumerate(hist or [])
               if count > 0]
    indexed.sort(key=lambda item: (-item[0], item[1]))
    return [hour for _count, hour in indexed[:limit]]


@dataclass
class PersonMetrics:
    """1人分の表示用指標。betweenness が None のときは「—」表示。"""

    sent: int = 0
    received: int = 0
    pagerank: float = 0.0
    betweenness: float | None = None
    cluster_label: str | None = None
    cluster_size: int = 0
    partners: list[tuple[int, int, int]] = field(default_factory=list)


def analyze(edges: dict[int, dict[int, int]], user_id: int) -> PersonMetrics:
    """対象者1人分の指標をまとめて計算する（グラフ全体の計算を含む）。"""
    ranks = pagerank(edges)
    centrality = betweenness(edges)
    clusters = components(edges)
    label, size = clusters.get(user_id, (None, 0))
    return PersonMetrics(
        sent=out_total(edges, user_id),
        received=in_total(edges, user_id),
        pagerank=ranks.get(user_id, 0.0),
        betweenness=(centrality.get(user_id, 0.0)
                      if centrality is not None else None),
        cluster_label=label,
        cluster_size=size,
        partners=top_partners(edges, user_id),
    )
