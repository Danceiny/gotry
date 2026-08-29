/** The default composer body: the 'conversation.composer.bar' slot entry.
 * Machine state arrives through the standard provide channel
 * (useInput + inputActions); the keyboard/DOM command face and stop arrive
 * through this entry's own inject, whose hooks compartment binds
 * useNotices/useLexicon; layout-phase inputs (variant, placeholder,
 * region-slot content) ride the owner props. Session facts
 * (running/removed/promptError) are self-selected via useSession.
 *
 * The text surface is the shell-owned Lexical editor bound here through
 * ComposerContentEditable; chips render as decorator portals, and the
 * keymap registers submit/menu/paste gestures on the editor command layer.
 * The no-session state renders the SAME div inert as the Workspace-picker
 * trigger instead of a parallel tree.
 */
import type { ComposerBarProps } from '../contract/slots.ts';
export type InputBarProps = ComposerBarProps;
export declare function InputBar({ useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages, resolveSubmitMode, toggleCommandMenu, stop, command, t, renderSlot, useNotices, useLexicon, useMenuLauncher, useProjection, sessionId, variant, disabled: inert, blocked, workspacePickerOpen, onRequestWorkspace, placeholder, accessory, overlay, leftItems, rightItems, footer, }: InputBarProps): import("react").JSX.Element;
//# sourceMappingURL=InputBar.d.ts.map