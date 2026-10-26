// @vitest-environment node
/**
 * NIM-2420: a confirm field the agent left without a `defaultValue` used to seed
 * as `false` and validate unconditionally, so a user who never touched the
 * control submitted `value: false` -- indistinguishable on the wire from a
 * deliberate "No". These cover the answer contract, not the control's copy.
 */

import { describe, expect, it } from 'vitest';

import {
  draftToAnswers,
  fieldDraftValid,
  parseRequestUserInputResult,
  seedDraft,
} from '../requestUserInputFieldLogic';
import type { RequestUserInputArgs } from '../../../../../ai/server/providers/shared/requestUserInputTypes';

function confirmArgs(defaultValue?: boolean): RequestUserInputArgs {
  return {
    fields: [{ type: 'confirm', id: 'send', label: 'Send the emails?', ...(defaultValue === undefined ? {} : { defaultValue }) }],
  };
}

describe('confirm field draft logic', () => {
  it('blocks submit and emits no answer while untouched', () => {
    const args = confirmArgs();
    const draft = seedDraft(args);

    expect(fieldDraftValid(args.fields[0], draft.fields.send)).toBe(false);
    expect(draftToAnswers(args, draft)).toEqual({});
  });

  it.each([true, false])('emits the picked value (%s) once the user answers', (picked) => {
    const args = confirmArgs();
    const draft = seedDraft(args);
    draft.fields.send = { type: 'confirm', state: { value: picked } };

    expect(fieldDraftValid(args.fields[0], draft.fields.send)).toBe(true);
    expect(draftToAnswers(args, draft)).toEqual({
      send: { type: 'confirm', value: picked },
    });
  });

  it('honors an explicit defaultValue as a pre-selected, submittable answer', () => {
    const args = confirmArgs(true);
    const draft = seedDraft(args);

    expect(fieldDraftValid(args.fields[0], draft.fields.send)).toBe(true);
    expect(draftToAnswers(args, draft)).toEqual({
      send: { type: 'confirm', value: true },
    });
  });
});

// A permission denial or error string is the tool's terminal result. The form
// treated it as no result and stayed answerable, while question navigation
// (partitionUnansweredQuestions) already counted it as answered.
describe('form result parsing', () => {
  it('closes the form on a result with no answers in it', () => {
    const denial = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
    expect(parseRequestUserInputResult(denial)).toMatchObject({ cancelled: true, answers: {} });
    expect(parseRequestUserInputResult([{ type: 'text', text: denial }])).toMatchObject({ cancelled: true, answers: {} });
  });

  it('keeps answers, cancels and an absent result as before', () => {
    const answers = { ok: { type: 'confirm', value: true } };
    expect(parseRequestUserInputResult(JSON.stringify({ answers }))).toEqual({ cancelled: false, answers });
    expect(parseRequestUserInputResult(JSON.stringify({ cancelled: true, reason: 'superseded' }))).toEqual({ cancelled: true, reason: 'superseded', answers: {} });
    expect(parseRequestUserInputResult(undefined)).toBeNull();
    expect(parseRequestUserInputResult('')).toBeNull();
  });
});
