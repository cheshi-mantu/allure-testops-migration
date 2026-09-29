import { Alert, Autocomplete, Badge, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, type ReactNode } from "react";
import { errorText } from "../api/client";
import { useProfile } from "./ProfileContext";

/**
 * Loads live data from TestRail and Allure TestOps for mapping screens and shows the children
 * once the data is there. Loads automatically the first time.
 */
export function DiscoveryGate({ children, needTestOps = true }: { children: ReactNode; needTestOps?: boolean }) {
  const { profile, testrail, testops, refreshDiscovery } = useProfile();
  const started = useRef(false);
  const ready = Boolean(profile.testrail.scope.projectId && (!needTestOps || profile.testops.scope.projectId));

  useEffect(() => {
    if (!ready || started.current) {
      return;
    }
    started.current = true;
    const missing = !testrail.data && !testrail.isFetching ? "testrail" : null;
    const missingTarget = needTestOps && !testops.data && !testops.isFetching ? "testops" : null;
    if (missing && missingTarget) {
      void refreshDiscovery("both");
    } else if (missing || missingTarget) {
      void refreshDiscovery((missing ?? missingTarget)!);
    }
  }, [ready, needTestOps, testrail.data, testrail.isFetching, testops.data, testops.isFetching, refreshDiscovery]);

  if (!ready) {
    return <Alert color="yellow">Choose the TestRail{needTestOps ? " and Allure TestOps" : ""} project first (step 2).</Alert>;
  }
  const loading = testrail.isFetching || (needTestOps && testops.isFetching);
  const error = testrail.error ?? (needTestOps ? testops.error : null);
  if (loading && !testrail.data) {
    return (
      <Group>
        <Loader size="sm" />
        <Text c="dimmed">Reading projects, suites, sections, fields and sample cases…</Text>
      </Group>
    );
  }
  if (error) {
    return (
      <Alert color="red" title="Could not load data">
        <Stack gap="xs">
          <Text size="sm">{errorText(error)}</Text>
          <Group>
            <Button size="xs" variant="light" onClick={() => void refreshDiscovery()}>
              Try again
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }
  if (!testrail.data || (needTestOps && !testops.data)) {
    return <Loader size="sm" />;
  }
  const warnings = [...testrail.data.warnings, ...(needTestOps ? (testops.data?.warnings ?? []) : [])];
  return (
    <Stack>
      {warnings.length > 0 && (
        <Alert color="yellow" title="Some data could not be read">
          {warnings.map((warning) => (
            <Text size="sm" key={warning}>
              {warning}
            </Text>
          ))}
        </Alert>
      )}
      {children}
    </Stack>
  );
}

export function RefreshButton() {
  const { testrail, testops, refreshDiscovery } = useProfile();
  return (
    <Button
      variant="subtle"
      size="xs"
      leftSection={<IconRefresh size={14} />}
      loading={testrail.isFetching || testops.isFetching}
      onClick={() => void refreshDiscovery()}
    >
      Reload from TestRail and Allure TestOps
    </Button>
  );
}

/** Custom field name input suggesting existing Allure TestOps fields; unknown names are created on migration. */
export function CustomFieldInput({
  value,
  onChange,
  placeholder = "Not migrated",
  label,
  description,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  label?: string;
  description?: string;
}) {
  const { testops } = useProfile();
  const fields = testops.data?.customFields ?? [];
  const existing = fields.find((f) => f.name === value);
  const data = [
    { group: "In this project", items: fields.filter((f) => f.inProject).map((f) => f.name) },
    { group: "Other custom fields", items: fields.filter((f) => !f.inProject).map((f) => f.name) },
  ].filter((g) => g.items.length > 0);
  return (
    <Autocomplete
      label={label}
      description={description}
      placeholder={placeholder}
      data={data}
      value={value ?? ""}
      onChange={(next) => onChange(next.trim() === "" ? null : next)}
      rightSectionWidth={value ? 64 : undefined}
      rightSection={
        value ? (
          existing ? (
            existing.inProject ? null : (
              <Badge size="xs" variant="light" color="gray">
                add
              </Badge>
            )
          ) : (
            <Badge size="xs" variant="light" color="teal">
              new
            </Badge>
          )
        ) : null
      }
      comboboxProps={{ withinPortal: true }}
      limit={50}
      maxDropdownHeight={280}
    />
  );
}
