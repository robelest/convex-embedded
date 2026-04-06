import React from "react";
import { View, StyleSheet } from "react-native";

import type { Status } from "@/src/data/mock";
import { statusColors } from "@/src/theme";

export function StatusDot({ status }: { status: Status }) {
  return (
    <View style={[styles.dot, { backgroundColor: statusColors[status] }]} />
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
