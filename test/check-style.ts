// 検査を、書き方の提案（level: style）も含めて呼ぶ。テストだけが使う（xwb check --style と同じ）。
// 規則ごとのテストは、種類に関わらず、規則が拾うかを確かめるので、こちらを使う。種類の出し分けは check.test.ts の「検査の種類」で確かめる
import { checkBoard as check, type CheckContext, type Issue } from "../src/shared/check.ts";
import type { Doc } from "../src/shared/model.ts";

export function checkBoard(doc: Doc, ctx: CheckContext = {}): Issue[] {
  return check(doc, { ...ctx, style: true });
}
