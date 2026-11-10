import type { Translations } from "../words"

/** The translations of the edit and delete tools' words: their titles, intents, headline templates, the `Message` and `Current` fact labels and the text label (the `Chat` fact's and the `message {id}` value template are the shared ones). */
export const ACTION_TRANSLATIONS: Translations = {
  ja: {
    "Edit a message": "メッセージを編集する",
    "Delete a message for everyone": "メッセージを全員分削除する",
    "About to edit a message": "メッセージを編集しようとしています",
    "About to delete a message": "メッセージを削除しようとしています",
    "About to edit message {id} in {chat}": "{chat} のメッセージ {id} を編集しようとしています",
    "About to edit message {id} in Saved Messages": "保存済みメッセージのメッセージ {id} を編集しようとしています",
    "About to delete message {id} from {chat}": "{chat} のメッセージ {id} を削除しようとしています",
    "About to delete message {id} from Saved Messages": "保存済みメッセージのメッセージ {id} を削除しようとしています",
    Message: "メッセージ",
    Current: "現在の内容",
    "New text": "新しい本文",
  },
}
