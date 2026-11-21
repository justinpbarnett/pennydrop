import type { Challenge } from "../format";

export interface CourseTopic {
  id: number;
  code: string;
  title: string;
  part: number;
  subtopics: string[];
  lesson_id: string | null;
  lesson_status: string | null;
}

export interface Course {
  id: number;
  slug: string;
  title: string;
  summary: string;
  honor_code: string;
  topics: CourseTopic[];
}

export interface ReviewItem {
  id: number;
  profile_id: number;
  lesson_id: string;
  step_n: number;
  prompt: Challenge;
  schedule: { ease: number; interval_days: number; reps: number; lapses: number };
  due: string;
  lesson_title: string | null;
  kind: string | null;
  type: string;
  answer_shape: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

export const fetchCourses = () => getJson<Course[]>("/api/courses");
export const fetchCourse = (reference: string) => getJson<Course>(`/api/courses/${encodeURIComponent(reference)}`);
export const fetchDue = (profile: number) => getJson<ReviewItem[]>(`/api/review?profile_id=${profile}`);
export const fetchQueue = (profile: number) => getJson<ReviewItem[]>(`/api/review/queue?profile_id=${profile}`);
export const fetchLessonDocument = (id: string) => getJson<Record<string, unknown>>(`/api/lessons/${encodeURIComponent(id)}`);

export async function answerReview(item: number, answer: unknown, correct: boolean): Promise<ReviewItem> {
  const response = await fetch(`/api/review/${item}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer, correct }) });
  if (!response.ok) throw new Error(`the answer was not saved: the server answered ${response.status}`);
  return (await response.json()) as ReviewItem;
}

export function comesBack(iso: string, now = new Date()): string {
  const due = new Date(iso);
  const minutes = Math.round((due.getTime() - now.getTime()) / 60000);
  const absolute = due.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (minutes <= 0) return `due now (${absolute})`;
  if (minutes < 60) return `in ${minutes} min (${absolute})`;
  if (minutes < 60 * 36) return `in ${Math.round(minutes / 60)} h (${absolute})`;
  return `in ${Math.round(minutes / 1440)} days (${absolute})`;
}
