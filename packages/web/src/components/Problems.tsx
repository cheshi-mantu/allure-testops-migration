import { Alert, Anchor, Badge, Button, Code, Collapse, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle, IconArrowRight, IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { FixLink, PlannedNote, Profile, RunProblem } from "@atm/shared";
import { ApiError, errorText } from "../api/client";
import { useProfile } from "./ProfileContext";

const STEP_LABELS: Record<FixLink["step"], { testrail: string; csv: string }> = {
  connections: { testrail: "Connections", csv: "Connection" },
  file: { testrail: "CSV file", csv: "CSV file" },
  scope: { testrail: "Projects", csv: "Project" },
  structure: { testrail: "Suites & sections", csv: "Sections" },
  fields: { testrail: "Fields", csv: "Columns" },
  options: { testrail: "Options", csv: "Options" },
};

export function fixLabel(profile: Profile, fix: FixLink): string {
  const step = STEP_LABELS[fix.step][profile.source];
  return fix.field ? `${step}: ${fix.field}` : step;
}

/** Opens the step (and field) where the problem is fixed. */
export function FixButton({ fix, size = "xs" }: { fix: FixLink; size?: "xs" | "compact-sm" }) {
  const { profile } = useProfile();
  const navigate = useNavigate();
  return (
    <Button
      size={size}
      variant="light"
      rightSection={<IconArrowRight size={14} />}
      onClick={() => navigate(`/profiles/${profile.id}/${fix.step}${fix.field ? `?field=${encodeURIComponent(fix.field)}` : ""}`)}
    >
      Fix in {fixLabel(profile, fix)}
    </Button>
  );
}

/** An error with what the server said, why, and where to fix it. */
export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  const api = error instanceof ApiError ? error : null;
  return (
    <Alert color="red" icon={<IconAlertCircle size={16} />} title={title ?? errorText(error)}>
      <Stack gap="xs">
        {title && <Text size="sm">{errorText(error)}</Text>}
        {api?.hint && <Text size="sm">{api.hint}</Text>}
        {api?.detail && api.detail !== api.message && <ServerMessage text={api.detail} />}
        {api?.fix && (
          <Group>
            <FixButton fix={api.fix} />
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

function ServerMessage({ text }: { text: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        Message from the server
      </Text>
      <Code block style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </Code>
    </div>
  );
}

export function NoteList({ notes }: { notes: PlannedNote[] }) {
  return (
    <Stack gap="sm">
      {notes.map((note, index) => (
        <Stack key={`${note.code}-${index}`} gap={4}>
          <Text size="sm" fw={500}>
            {note.text}
          </Text>
          {note.hint && (
            <Text size="sm" c="dimmed">
              {note.hint}
            </Text>
          )}
          {note.fix && (
            <Group>
              <FixButton fix={note.fix} />
            </Group>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

const SHOWN_CASES = 40;

function ProblemItem({ problem }: { problem: RunProblem }) {
  const [allCases, setAllCases] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const error = problem.level === "error";
  const cases = allCases ? problem.cases : problem.cases.slice(0, SHOWN_CASES);
  return (
    <Alert
      color={error ? "red" : "orange"}
      variant="light"
      icon={error ? <IconAlertCircle size={16} /> : <IconAlertTriangle size={16} />}
      title={
        <Group gap="xs" wrap="nowrap">
          <span>{problem.title}</span>
          <Badge size="sm" variant="filled" color={error ? "red" : "orange"}>
            {problem.count} {problem.count === 1 ? "time" : "times"}
          </Badge>
        </Group>
      }
    >
      <Stack gap="xs">
        <Text size="sm">{problem.hint}</Text>
        {problem.detail && (
          <>
            <Anchor size="xs" component="button" type="button" ta="left" onClick={() => setDetailOpen((v) => !v)}>
              {detailOpen ? "Hide" : "Show"} the message from the server
            </Anchor>
            <Collapse expanded={detailOpen}>
              <ServerMessage text={problem.detail} />
            </Collapse>
          </>
        )}
        {problem.cases.length > 0 && (
          <div>
            <Group gap={6} mb={4}>
              <Text size="xs" c="dimmed">
                Affected {problem.cases[0]!.startsWith("Line") ? "records" : "cases"}:
              </Text>
              <CopyButton value={problem.cases.join(", ")}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied" : "Copy the list"}>
                    <Anchor size="xs" component="button" type="button" onClick={copy}>
                      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    </Anchor>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
            <Group gap={4}>
              {cases.map((label) => (
                <Badge key={label} size="sm" variant="outline" color="gray" tt="none">
                  {label}
                </Badge>
              ))}
              {problem.cases.length > SHOWN_CASES && (
                <Anchor size="xs" component="button" type="button" onClick={() => setAllCases((v) => !v)}>
                  {allCases ? "show fewer" : `and ${problem.cases.length - SHOWN_CASES} more`}
                </Anchor>
              )}
              {problem.count > problem.cases.length && problem.cases.length >= 500 && (
                <Text size="xs" c="dimmed">
                  (list shortened; the downloaded log has all lines)
                </Text>
              )}
            </Group>
          </div>
        )}
        {problem.fix && (
          <Group>
            <FixButton fix={problem.fix} />
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

export function ProblemList({ problems }: { problems: RunProblem[] }) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <Stack gap="xs">
      {problems.map((problem) => (
        <ProblemItem key={problem.key} problem={problem} />
      ))}
    </Stack>
  );
}
