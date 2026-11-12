import React, { createRef, useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import { AgentWorkstreamLayout } from "../AgentWorkstreamLayout";
import { FilePlacementControl } from "../FilePlacementControl";
import { agentFilePlacementAtom, type AgentFilePlacement } from "../../../store/atoms/agentFilePlacement";
import { cleanupWorkstreamAtom, initWorkstreamState } from "../../../store/atoms/workstreamState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the editor DOM and local editing state through placement, hiding, and maximize/restore", () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Editor() {
    const [text, setText] = useState("saved");
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return (
      <textarea
        aria-label="Editor"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }
  const props = {
    panelRef: createRef<HTMLDivElement>(),
    editorRef: createRef<HTMLDivElement>(),
    sessionRef: createRef<HTMLDivElement>(),
    rightPanelRef: createRef<HTMLDivElement>(),
    placement: "above" as const,
    layoutMode: "split" as const,
    editorVisible: true,
    sidebarVisible: true,
    viewerSelected: false,
    sidebarWidth: 300,
    splitRatio: 0.5,
    draggingVertical: false,
    draggingSidebar: false,
    onVerticalResize: vi.fn(),
    onSidebarResize: vi.fn(),
    header: <span>Header</span>,
    editor: <Editor />,
    transcript: <span>Transcript</span>,
    sidebar: <span>Review</span>,
  };
  const view = render(<AgentWorkstreamLayout {...props} />);
  const input = view.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "unsaved edit" } });
  input.setSelectionRange(2, 7);
  for (const state of [
    { placement: "right" as const, viewerSelected: true },
    {
      placement: "right" as const,
      viewerSelected: false,
      editorVisible: false,
    },
    {
      placement: "right" as const,
      viewerSelected: true,
      editorVisible: false,
      sidebarVisible: false,
    },
    {
      placement: "right" as const,
      viewerSelected: true,
      layoutMode: "editor" as const,
      sidebarVisible: false,
    },
    { placement: "right" as const, viewerSelected: true },
    { placement: "above" as const },
  ]) {
    view.rerender(
      <AgentWorkstreamLayout {...props} {...state} editor={<Editor />} />
    );
    expect(view.container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("unsaved edit");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  }
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});

function renderPlacementControl(placement: AgentFilePlacement = "right") {
  initWorkstreamState("/layout-picker-test");
  const store = createStore();
  store.set(agentFilePlacementAtom, placement);
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("electronAPI", { invoke });
  const onBeforeMove = vi.fn();
  render(<Provider store={store}><FilePlacementControl workstreamId="layout-picker" onBeforeMove={onBeforeMove} /></Provider>);
  return { store, invoke, onBeforeMove };
}

it.each([
  ["right", "Side by side"],
  ["above", "Stacked"],
] as const)("opening the layout picker preserves the %s layout and marks its current choice", async (placement, label) => {
  const { store, invoke, onBeforeMove } = renderPlacementControl(placement);
  fireEvent.click(screen.getByRole("button", { name: `File layout: ${label}` }));
  const current = await screen.findByRole("menuitemradio", { name: new RegExp(label) });
  expect(current.getAttribute("aria-checked")).toBe("true");
  expect(store.get(agentFilePlacementAtom)).toBe(placement);
  fireEvent.click(current);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(store.get(agentFilePlacementAtom)).toBe(placement);
  expect(invoke).not.toHaveBeenCalled();
  expect(onBeforeMove).not.toHaveBeenCalled();
});

it("changes layout only when an explicit different choice is selected", async () => {
  const { store, invoke, onBeforeMove } = renderPlacementControl();
  fireEvent.click(screen.getByRole("button", { name: "File layout: Side by side" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Stacked/ }));
  expect(store.get(agentFilePlacementAtom)).toBe("above");
  expect(invoke).toHaveBeenCalledWith("app-settings:set", "agentFilePlacement", "above");
  expect(onBeforeMove).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "File layout: Stacked" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Side by side/ }));
  expect(store.get(agentFilePlacementAtom)).toBe("right");
  expect(invoke).toHaveBeenCalledWith("app-settings:set", "agentFilePlacement", "right");
  expect(onBeforeMove).toHaveBeenCalledTimes(2);
  store.set(cleanupWorkstreamAtom, "layout-picker");
});

it("dismisses the layout menu with Escape without changing the saved layout", async () => {
  const { store, invoke, onBeforeMove } = renderPlacementControl();
  const trigger = screen.getByRole("button", { name: "File layout: Side by side" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole("menu");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(store.get(agentFilePlacementAtom)).toBe("right");
  expect(invoke).not.toHaveBeenCalled();
  expect(onBeforeMove).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("dismisses the layout menu on an outside click without changing layout", async () => {
  const { store, invoke } = renderPlacementControl();
  fireEvent.click(screen.getByRole("button", { name: "File layout: Side by side" }));
  await screen.findByRole("menu");
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(store.get(agentFilePlacementAtom)).toBe("right");
  expect(invoke).not.toHaveBeenCalled();
});

it("lets keyboard users inspect both choices without changing layout", async () => {
  const { store, invoke } = renderPlacementControl();
  const trigger = screen.getByRole("button", { name: "File layout: Side by side" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const sideBySide = await screen.findByRole("menuitemradio", { name: /Side by side/ });
  await waitFor(() => expect(document.activeElement).toBe(sideBySide));
  fireEvent.keyDown(sideBySide, { key: "ArrowDown" });
  const stacked = screen.getByRole("menuitemradio", { name: /Stacked/ });
  await waitFor(() => expect(document.activeElement).toBe(stacked));
  expect(store.get(agentFilePlacementAtom)).toBe("right");
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.keyDown(stacked, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
