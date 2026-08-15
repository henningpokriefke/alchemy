/**
 * Composable terminal layouts and interaction widgets.
 *
 * This is a separate entrypoint from `alchemy/Cli/CliKit` so importing the
 * injectable service does not eagerly load React, Ink or Yoga.
 */
export {
  CliEnvironment,
  useCliEnvironment,
  useGlyphs,
  useKeyGlyphs,
} from "./components/Environment.tsx";
export {
  Box,
  Gutter,
  Heading,
  Row,
  SectionHeading,
  Stack,
  Viewport,
  type BoxProps,
  type RowProps,
  type StackProps,
} from "./components/Layout.tsx";
export {
  Link,
  Text,
  type TextProps,
  type TextTone,
} from "./components/Typography.tsx";
export {
  Alert,
  KeyBar,
  ProgressBar,
  Spinner,
  SpinnerGlyph,
  Status,
  Tabs,
  type AlertProps,
  type StatusProps,
} from "./components/Feedback.tsx";
export { DescriptionList, type DescriptionItem } from "./components/Data.tsx";
export {
  BooleanChoice,
  CycleList,
  InlineConfirm,
  TextField,
  useCycleNavigation,
  useTerminalInput,
  useTerminalPaste,
  useTerminalSize,
  type CycleListProps,
  type TerminalKey,
  type TextFieldProps,
} from "./components/Interactive.tsx";
export { AnsweredPrompt, CancelledPrompt } from "./components/Transcript.tsx";
export {
  LiveStore,
  ProgressGroup,
  TaskRow,
  useLiveStore,
  type ProgressGroupRow,
  type TaskRowProps,
} from "./components/Live.tsx";
