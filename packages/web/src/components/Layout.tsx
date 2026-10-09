import { ActionIcon, AppShell, Group, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconArrowsExchange, IconMoon, IconSun } from "@tabler/icons-react";
import { Link, Outlet } from "react-router-dom";

export function Layout() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <Group gap="xs">
              <IconArrowsExchange size={22} color="var(--mantine-color-blue-6)" />
              <Text fw={700}>Allure TestOps Migration</Text>
              <Text c="dimmed" size="sm" visibleFrom="sm">
                TestRail, Xray, CSV → Allure TestOps
              </Text>
            </Group>
          </Link>
          <Tooltip label={scheme === "dark" ? "Light theme" : "Dark theme"}>
            <ActionIcon variant="subtle" aria-label="Toggle color scheme" onClick={() => setColorScheme(scheme === "dark" ? "light" : "dark")}>
              {scheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
