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
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await createTask({ title, body });
    setTitle("");
    setBody("");
  };

  const handleUpdate = async (id: string) => {
    await updateTask({ id: id as any, title: editTitle, body: editBody });
    setEditingId(null);
  };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 24 }}>
      <h1>convex-resolve demo</h1>
      <p style={{ color: "#666" }}>
        Tasks are synced via Convex with offline-first CRDT resolution.
      </p>

      <form onSubmit={handleCreate} style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            style={{ flex: 1, padding: 8 }}
          />
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Body"
            style={{ flex: 2, padding: 8 }}
          />
          <button type="submit" style={{ padding: "8px 16px" }}>
            Add
          </button>
        </div>
      </form>

      {tasks === undefined ? (
        <p>Loading...</p>
      ) : tasks.length === 0 ? (
        <p style={{ color: "#999" }}>No tasks yet. Create one above.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {tasks.map((task) => (
            <li
              key={task._id}
              style={{
                padding: 12,
                borderBottom: "1px solid #eee",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {editingId === task._id ? (
                <>
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    style={{ flex: 1, padding: 4 }}
                  />
                  <input
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    style={{ flex: 2, padding: 4 }}
                  />
                  <button onClick={() => handleUpdate(task._id)}>Save</button>
                  <button onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <strong style={{ flex: 1 }}>{task.title}</strong>
                  <span style={{ flex: 2, color: "#666" }}>{task.body}</span>
                  <button
                    onClick={() => {
                      setEditingId(task._id);
                      setEditTitle(task.title);
                      setEditBody(task.body);
                    }}
                  >
                    Edit
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
