import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

import { colors } from "@/src/theme";

interface Member {
  userId: string;
  name: string;
}

export function AssigneePicker({
  value,
  assigneeName,
  members,
  onSelect,
}: {
  value: string | null;
  assigneeName: string | null;
  members: Member[];
  onSelect: (userId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.trigger}>
        {assigneeName ? (
          <View style={styles.avatarRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{assigneeName.charAt(0)}</Text>
            </View>
            <Text style={styles.name}>{assigneeName}</Text>
          </View>
        ) : (
          <Text style={styles.unassigned}>Unassigned</Text>
        )}
        <Text style={styles.chevron}>{expanded ? "▲" : "▼"}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.dropdown}>
          <Pressable
            onPress={() => {
              onSelect(null);
              setExpanded(false);
            }}
            style={[styles.option, !value && styles.optionActive]}
          >
            <Text
              style={[styles.optionText, !value && styles.optionTextActive]}
            >
              Unassigned
            </Text>
          </Pressable>
          {members.map((member) => (
            <Pressable
              key={member.userId}
              onPress={() => {
                onSelect(member.userId);
                setExpanded(false);
              }}
              style={[
                styles.option,
                value === member.userId && styles.optionActive,
              ]}
            >
              <View style={styles.optionAvatarRow}>
                <View style={styles.smallAvatar}>
                  <Text style={styles.smallAvatarText}>
                    {member.name.charAt(0)}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.optionText,
                    value === member.userId && styles.optionTextActive,
                  ]}
                >
                  {member.name}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accent[500],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 12, fontWeight: "700", color: colors.white },
  name: { fontSize: 15, fontWeight: "500", color: colors.warm[800] },
  unassigned: { fontSize: 15, color: colors.warm[400] },
  chevron: { fontSize: 10, color: colors.warm[400] },

  dropdown: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.warm[200],
    backgroundColor: colors.white,
    overflow: "hidden",
    borderCurve: "continuous",
  },
  option: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.warm[200],
  },
  optionActive: { backgroundColor: colors.accent[500] + "10" },
  optionText: { fontSize: 14, color: colors.warm[700] },
  optionTextActive: { color: colors.accent[600], fontWeight: "600" },
  optionAvatarRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  smallAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.warm[400],
    alignItems: "center",
    justifyContent: "center",
  },
  smallAvatarText: { fontSize: 9, fontWeight: "700", color: colors.white },
});
