import type { Translations } from "../words"

/** The translations of the action tools' words (edit, delete, reaction, pin): their titles, intents, headline templates, the `Message`, `Current`, `Replaces`, `Notify` and `Both sides` fact labels and the text label (the `Chat` fact's, the `message {id}` value template and `Yes` are the shared ones). */
export const ACTION_TRANSLATIONS: Translations = {
  ja: {
    "Edit a message": "メッセージを編集する",
    "Delete a message for everyone": "メッセージを全員分削除する",
    "Set or remove a reaction": "リアクションを付ける・外す",
    "Pin or unpin a message": "メッセージをピン留めする・解除する",
    "About to edit a message": "メッセージを編集しようとしています",
    "About to delete a message": "メッセージを削除しようとしています",
    "About to change a reaction": "リアクションを変更しようとしています",
    "About to pin or unpin a message": "メッセージのピン留めを変更しようとしています",
    "About to edit message {id} in {chat}": "{chat} のメッセージ {id} を編集しようとしています",
    "About to edit message {id} in Saved Messages": "保存済みメッセージのメッセージ {id} を編集しようとしています",
    "About to delete message {id} from {chat}": "{chat} のメッセージ {id} を削除しようとしています",
    "About to delete message {id} from Saved Messages": "保存済みメッセージのメッセージ {id} を削除しようとしています",
    "About to react {emoji} to message {id} in {chat}":
      "{chat} のメッセージ {id} に {emoji} のリアクションを付けようとしています",
    "About to react {emoji} to message {id} in Saved Messages":
      "保存済みメッセージのメッセージ {id} に {emoji} のリアクションを付けようとしています",
    "About to remove your reaction from message {id} in {chat}":
      "{chat} のメッセージ {id} から自分のリアクションを外そうとしています",
    "About to remove your reaction from message {id} in Saved Messages":
      "保存済みメッセージのメッセージ {id} から自分のリアクションを外そうとしています",
    "About to pin message {id} in {chat}": "{chat} のメッセージ {id} をピン留めしようとしています",
    "About to pin message {id} in Saved Messages": "保存済みメッセージのメッセージ {id} をピン留めしようとしています",
    "About to unpin message {id} in {chat}": "{chat} のメッセージ {id} のピン留めを解除しようとしています",
    "About to unpin message {id} in Saved Messages":
      "保存済みメッセージのメッセージ {id} のピン留めを解除しようとしています",
    Message: "メッセージ",
    Current: "現在の内容",
    Replaces: "置き換えるリアクション",
    Notify: "通知",
    "Both sides": "相手側にも",
    "New text": "新しい本文",
  },
}
