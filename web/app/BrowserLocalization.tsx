"use client";

import { useEffect } from "react";

type Locale = "ja" | "en" | "zh";

type Translation = [string, string, string];

// 固定UI文言だけを置換し、Botから生成されるコマンドデータはそのまま表示する。
const TRANSLATIONS: Translation[] = [
  ["AGOBOT サポート", "AGOBOT Support", "AGOBOT 支持"],
  ["Discordに追加", "Add to Discord", "添加到Discord"],
  ["サポートサーバー", "Support server", "支持服务器"],
  ["コマンド一覧", "Commands", "命令列表"],
  ["利用規約", "Terms of Service", "服务条款"],
  ["プライバシーポリシー", "Privacy Policy", "隐私政策"],
  ["分かりやすく、幅広く。", "Clear and comprehensive.", "清晰而全面。"],
  ["ゲームも音楽も、Discordで使える機能のコマンドと使い方をまとめています。", "Commands and guides for games, music, and other Discord features.", "这里汇总了游戏、音乐以及其他 Discord 功能的命令和使用方法。"],
  ["コマンド一覧を見る →", "View commands →", "查看命令 →"],
  ["よく使うコマンド", "Popular commands", "常用命令"],
  ["ゲームで遊ぶ", "Play games", "玩游戏"],
  ["遊ぶゲームを選び、ルールを確認して募集を始めます。", "Choose a game, check its rules, and start recruiting players.", "选择游戏、查看规则并开始招募玩家。"],
  ["音楽を楽しむ", "Enjoy music", "享受音乐"],
  ["URLや検索語から再生し、キューや音響を操作できます。", "Play from a URL or search term and control the queue and audio.", "可以通过 URL 或搜索词播放，并控制队列和音频。"],
  ["コマンドを検索", "Search commands", "搜索命令"],
  ["サーバー内のみ", "Server only", "仅限服务器"],
  ["例：", "Example: ", "示例："],
  ["（必須）", " (required)", "（必填）"],
  ["ルールを見る", "View rules", "查看规则"],
  ["ゲームのルール", "Game rules", "游戏规则"],
  ["ゲーム", "Games", "游戏"],
  ["ルールはまだ登録されていません。", "No rules have been registered yet.", "尚未登记规则。"],
  ["サンプルのデータです", "sample data", "示例数据"],
  ["人狼 役職図鑑", "Werewolf role guide", "狼人角色图鉴"],
  ["マップ", "Map", "地图"],
  ["国づくり", "Nation building", "国家建设"],
  ["ランキング", "Rankings", "排行榜"],
  ["使い方", "How to use", "使用方法"],
  ["最終更新：", "Last updated: ", "最后更新："],
  ["← 役職図鑑にもどる", "← Back to role guide", "← 返回角色图鉴"],
  ["この役職の絵はまだありません。", "This role does not have an image yet.", "该角色暂时没有图片。"],
  ["制定日：", "Established: ", "制定日期："],
  ["最終更新日：", "Last updated: ", "最后更新日期："],
  ["まだデータがありません / 準備中です。", "There is no data yet / Coming soon.", "暂无数据 / 即将推出。"],
  ["国の一覧", "Nation list", "国家列表"],
  ["まだ国はありません。", "There are no nations yet.", "目前还没有国家。"],
  ["国", "Nation", "国家"],
  ["タイル数", "Tiles", "地块数"],
  ["首都", "Capital", "首都"],
];

function getLocale(): Locale {
  const language = navigator.languages?.[0] ?? navigator.language ?? "ja";
  if (language.toLowerCase().startsWith("zh")) return "zh";
  if (language.toLowerCase().startsWith("en")) return "en";
  return "ja";
}

function replaceText(root: Node, locale: Locale) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);
  for (const textNode of textNodes) {
    if (!textNode.data.trim()) continue;
    const translation = TRANSLATIONS.find(([ja]) => ja === textNode.data.trim());
    if (!translation || locale === "ja") continue;
    const [, en, zh] = translation;
    textNode.data = locale === "en" ? en : zh;
  }
}

function replaceAttributes(root: ParentNode, locale: Locale) {
  if (locale === "ja") return;
  for (const element of root.querySelectorAll<HTMLElement>("[aria-label], [placeholder], [title]")) {
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const translation = TRANSLATIONS.find(([ja]) => ja === value);
      if (!translation) continue;
      const [, en, zh] = translation;
      element.setAttribute(attribute, locale === "en" ? en : zh);
    }
  }
}

export default function BrowserLocalization() {
  useEffect(() => {
    const locale = getLocale();
    document.documentElement.lang = locale;
    if (locale === "ja") return;
    replaceText(document.body, locale);
    replaceAttributes(document.body, locale);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const addedNode of mutation.addedNodes) {
          replaceText(addedNode, locale);
          if (addedNode.nodeType === Node.ELEMENT_NODE) {
            replaceAttributes(addedNode as HTMLElement, locale);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
