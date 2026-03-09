import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useState } from "react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const tasks = useQuery(api.tasks.list);
  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const removeTask = useMutation(api.tasks.remove);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await createTask({ title: title.trim(), body: body.trim() });
    setTitle("");
    setBody("");
  };

  const startEdit = (task: { _id: string; title: string; body: string }) => {
    setEditingId(task._id);
    setEditTitle(task.title);
    setEditBody(task.body);
  };

  const handleUpdate = async () => {
    if (!editingId || !editTitle.trim()) return;
    await updateTask({
      id: editingId as any,
      title: editTitle.trim(),
      body: editBody.trim(),
    });
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await removeTask({ id: id as any });
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  return (
    <div className="space-y-6">
      {/* Intro */}
      <div className="rounded-lg bg-accent-light/50 border border-accent/20 px-4 py-3">
        <p className="text-sm text-accent">
          This app runs a full Convex backend{" "}
          <span className="font-semibold">in your browser</span> via the
          embedded runtime. Toggle the network switch above to go offline — the
          app keeps working. When you reconnect, CRDT diffs are resolved
          automatically.
        </p>
      </div>

      {/* Create form */}
      <form onSubmit={handleCreate} className="space-y-3">
        <div className="flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm
                       placeholder:text-text-tertiary
                       focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent
                       transition-colors"
          />
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Description (optional)"
            className="flex-[2] rounded-lg border border-border bg-bg px-3 py-2 text-sm
                       placeholder:text-text-tertiary
                       focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent
                       transition-colors"
          />
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white
                       hover:bg-accent-hover active:scale-[0.98]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-all"
          >
            Add
          </button>
        </div>
      </form>

      {/* Task list */}
      {tasks === undefined ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-bg p-4 animate-pulse"
            >
              <div className="h-4 w-1/3 rounded bg-bg-tertiary" />
              <div className="mt-2 h-3 w-2/3 rounded bg-bg-tertiary" />
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <p className="text-sm text-text-tertiary">
            No tasks yet. Create one above.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li
              key={task._id}
              className="group rounded-lg border border-border bg-bg
                         hover:border-border-hover hover:shadow-sm
                         transition-all"
            >
              {editingId === task._id ? (
                /* Edit mode */
                <div className="p-4 space-y-3">
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium
                               focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent
                               transition-colors"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUpdate();
                      if (e.key === "Escape") cancelEdit();
                    }}
                  />
                  <input
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    placeholder="Description"
                    className="w-full rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-secondary
                               placeholder:text-text-tertiary
                               focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent
                               transition-colors"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUpdate();
                      if (e.key === "Escape") cancelEdit();
                    }}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleUpdate}
                      disabled={!editTitle.trim()}
                      className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white
                                 hover:bg-accent-hover disabled:opacity-40
                                 transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="rounded-md border border-border px-3 py-1 text-xs font-medium text-text-secondary
                                 hover:bg-bg-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div className="flex items-start gap-3 p-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text truncate">
                      {task.title}
                    </p>
                    {task.body && (
                      <p className="mt-0.5 text-sm text-text-secondary truncate">
                        {task.body}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => startEdit(task)}
                      className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary
                                 hover:bg-bg-secondary hover:text-text transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(task._id)}
                      className="rounded-md px-2 py-1 text-xs font-medium text-danger
                                 hover:bg-red-50 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Footer info */}
      {tasks && tasks.length > 0 && (
        <p className="text-center text-xs text-text-tertiary">
          {tasks.length} task{tasks.length !== 1 ? "s" : ""} — all data stored
          locally in the browser via convex-embedded
        </p>
      )}
    </div>
  );
}
