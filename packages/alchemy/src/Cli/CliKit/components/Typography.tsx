/** @jsxImportSource react */
import { Text as InkText } from "ink";
import type { ComponentProps } from "react";
import { theme } from "../theme.ts";
import { hyperlink } from "../terminal.ts";
import { useCliEnvironment } from "./Environment.tsx";

export type TextTone =
  | "default"
  | "muted"
  | "emphasis"
  | "brand"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface TextProps extends Omit<
  ComponentProps<typeof InkText>,
  "color"
> {
  readonly tone?: TextTone;
  readonly color?: string;
}

/** CliKit typography primitive. Consumers never need to import Ink directly. */
export function Text({
  tone = "default",
  color,
  backgroundColor,
  bold,
  dimColor,
  italic,
  underline,
  strikethrough,
  inverse,
  ...props
}: TextProps) {
  const { colors } = useCliEnvironment();
  return (
    <InkText
      {...props}
      color={
        colors
          ? (color ??
            (tone === "default" || tone === "muted"
              ? undefined
              : theme.color[tone]))
          : undefined
      }
      backgroundColor={colors ? backgroundColor : undefined}
      bold={colors ? bold : undefined}
      dimColor={colors ? (dimColor ?? tone === "muted") : undefined}
      italic={colors ? italic : undefined}
      underline={colors ? underline : undefined}
      strikethrough={colors ? strikethrough : undefined}
      inverse={colors ? inverse : undefined}
    />
  );
}

type LinkProps = {
  readonly href: string;
  readonly children?: string;
};

export function Link({ href, children }: LinkProps) {
  const { input } = useCliEnvironment();
  return (
    <Text tone="info" underline>
      {input ? hyperlink(children ?? href, href) : (children ?? href)}
    </Text>
  );
}
