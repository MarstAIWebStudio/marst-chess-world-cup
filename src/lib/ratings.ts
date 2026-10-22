export type MoveGrade =
  | "!!"
  | "!"
  | "?!"
  | "!?"
  | "?"
  | "??"
  | "-"
  | "📕"
  | "⭐";

export interface GradeResult {
  grade: MoveGrade;
  label: string;
  before: number;
  after: number;
  loss: number;
}

export interface RatingInput {
  before: number;
  after: number;
  bestMovePlayed: boolean;
  materialBefore: number;
  materialAfter: number;
  isBook?: boolean;
  isInteresting?: boolean;
}

export function gradeMove(input: RatingInput): GradeResult {
  const {
    before,
    after,
    bestMovePlayed,
    materialBefore,
    materialAfter,
    isBook = false,
    isInteresting = false,
  } = input;

  const loss = Math.max(0, before - after);

  let grade: MoveGrade;
  let label: string;

  // 이론수는 오프닝 데이터베이스의 검증이 필요하다.
  if (isBook) {
    grade = "📕";
    label = "이론수";
  } else if (bestMovePlayed) {
    // 최선수는 기물 점수 변화와 무관하게 유지한다.
    grade = "⭐";
    label = "최선수";
  } else if (loss >= 300) {
    grade = "??";
    label = "블런더";
  } else if (loss >= 150) {
    grade = "?";
    label = "실수";
  } else if (loss >= 80) {
    grade = "?!";
    label = "부정확한 수";
  } else if (isInteresting) {
    grade = "!?";
    label = "흥미수";
  } else if (loss <= 8 && materialBefore === materialAfter) {
    grade = "-";
    label = "기물 점수 유지";
  } else if (loss <= 15) {
    grade = "!!";
    label = "탁월";
  } else if (loss <= 40) {
    grade = "!";
    label = "좋은 수";
  } else {
    grade = "?!";
    label = "부정확한 수";
  }

  return {
    grade,
    label,
    before,
    after,
    loss,
  };
  }
