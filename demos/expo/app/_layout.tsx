import { DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { ConvexProvider } from "convex/react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { ActivityIndicator, InteractionManager, View } from "react-native";

import { EmbeddedClientProvider, getClient } from "@/src/convex-client";
import { OverlayGuardProvider } from "@/src/overlay-guard";
import { ProjectSelectionProvider } from "@/src/project-selection";

import "react-native-reanimated";

const WarmTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: "#c25d3a",
    background: "#fdfcfa",
    card: "#ffffff",
    text: "#1a1816",
    border: "#e8e2d8",
    notification: "#c25d3a",
  },
};

export default function RootLayout() {
  const [client, setClient] = React.useState<ReturnType<
    typeof getClient
  > | null>(null);

  React.useLayoutEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setClient(getClient());
    });
    return () => task.cancel();
  }, []);

  if (!client) {
    return (
      <ThemeProvider value={WarmTheme}>
        <View
          style={{
            flex: 1,
            backgroundColor: WarmTheme.colors.background,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ActivityIndicator color={WarmTheme.colors.primary} />
          <StatusBar style="dark" />
        </View>
      </ThemeProvider>
    );
  }

  return (
    <ConvexProvider client={client}>
      <EmbeddedClientProvider client={client}>
        <ThemeProvider value={WarmTheme}>
          <ProjectSelectionProvider>
            <OverlayGuardProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen
                  name="project-picker"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.85, 1.0],
                  }}
                />
                <Stack.Screen
                  name="project/[id]"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.7, 1.0],
                  }}
                />
                <Stack.Screen
                  name="issue/[id]"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.85, 1.0],
                  }}
                />
              </Stack>
            </OverlayGuardProvider>
          </ProjectSelectionProvider>
          <StatusBar style="dark" />
        </ThemeProvider>
      </EmbeddedClientProvider>
    </ConvexProvider>
  );
}
