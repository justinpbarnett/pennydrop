import { h } from "../dom";
import { type Course, type CourseTopic, fetchCourse, fetchCourses } from "./api";

const STATUS_LABELS: Record<string, string> = { ready: "Ready", writing: "Writing", failed: "Failed" };

function badge(topic: CourseTopic): HTMLElement {
  const status = topic.lesson_status ?? "none";
  return h("span", { class: `badge ${status}` }, STATUS_LABELS[status] ?? "Not written yet");
}

function topicRow(topic: CourseTopic): HTMLElement {
  const open = topic.lesson_id && topic.lesson_status === "ready"
    ? h("a", { class: "open", href: `/?lesson=${encodeURIComponent(topic.lesson_id)}` }, "Open Lesson")
    : h("span", { class: "open off" }, "No Lesson yet");
  return h("li", { class: "topic" },
    h("span", { class: "code" }, topic.code),
    h("div", { class: "topic-text" }, h("p", { class: "topic-title" }, topic.title), topic.subtopics.length ? h("p", { class: "topic-sub" }, `${topic.subtopics.length} subtopics`) : null),
    badge(topic),
    open);
}

export async function courseList(): Promise<HTMLElement> {
  const courses = await fetchCourses();
  if (courses.length === 0) return h("p", { class: "none" }, "No Courses yet. Load one with `pd course seed <file>`.");
  return h("div", { class: "course-grid" }, ...courses.map((course) => {
    const ready = course.topics.filter((topic) => topic.lesson_status === "ready").length;
    return h("a", { class: "course-card", href: `?course=${encodeURIComponent(course.slug)}` },
      h("p", { class: "kicker" }, course.slug.toUpperCase()),
      h("p", { class: "course-title" }, course.title),
      h("p", { class: "course-summary" }, course.summary),
      h("p", { class: "course-count" }, `${ready} of ${course.topics.length} Topics have a Lesson`));
  }));
}

export async function courseDetail(reference: string): Promise<HTMLElement> {
  const course: Course = await fetchCourse(reference);
  const parts = new Map<number, CourseTopic[]>();
  course.topics.forEach((topic) => parts.set(topic.part, [...(parts.get(topic.part) ?? []), topic]));
  return h("div", { class: "course" },
    h("a", { class: "back", href: "?view=courses" }, "All Courses"),
    h("h1", {}, course.title),
    h("p", { class: "lede" }, course.summary),
    h("p", { class: "honor" }, h("strong", {}, "Honor code. "), course.honor_code),
    ...Array.from(parts, ([part, topics]) => h("section", {}, h("h2", {}, `Part ${part}`), h("ul", { class: "topics" }, ...topics.map(topicRow)))));
}
