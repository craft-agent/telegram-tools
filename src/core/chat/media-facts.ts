import type { CallValue } from "../tool"
import type { Translations } from "../words"

/** The word of the tool's for every kind of media the mirror stores. */
export const MEDIA_KIND_WORDS: Readonly<Record<string, string>> = {
  photo: "Photo",
  document: "Document",
  audio: "Audio",
  voice: "Voice message",
  video: "Video",
  sticker: "Sticker",
  dice: "Dice",
  contact: "Contact",
  venue: "Venue",
  geo: "Location",
  geo_live: "Live location",
  game: "Game",
  invoice: "Invoice",
  webpage: "Link preview",
  poll: "Poll",
  todo: "Checklist",
  story: "Story",
  paid: "Paid media",
  unsupported: "Unsupported media",
}

/** A known media kind as a word of the tool's, else the mirror's stored string as data. */
export function mediaKindValue(type: string): string | CallValue {
  return Object.hasOwn(MEDIA_KIND_WORDS, type) ? { text: MEDIA_KIND_WORDS[type]! } : type
}

/** The translations of the `Media` label and the shared media kind words. */
export const MEDIA_FACT_TRANSLATIONS: Translations = {
  ja: {
    Media: "メディア",
    Photo: "写真",
    Document: "ドキュメント",
    Audio: "音声",
    "Voice message": "ボイスメッセージ",
    Video: "動画",
    Sticker: "スタンプ",
    Dice: "サイコロ",
    Contact: "連絡先",
    Venue: "場所",
    Location: "位置情報",
    "Live location": "ライブ位置情報",
    Game: "ゲーム",
    Invoice: "請求書",
    "Link preview": "リンクのプレビュー",
    Poll: "投票",
    Checklist: "チェックリスト",
    Story: "ストーリー",
    "Paid media": "有料メディア",
    "Unsupported media": "未対応のメディア",
  },
}
