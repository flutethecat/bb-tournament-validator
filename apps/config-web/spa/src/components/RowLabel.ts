// A nav row's label with an optional unread badge. A functional component so the row keeps ONE anchor (focus survives the
// badge appearing or going away) and a row without a badge renders bare text, i.e. ">Label</a>" with no placeholder comment.
import { h, type FunctionalComponent, type VNode } from "vue";
import { unreadBadge } from "../home/notifications";

export const RowLabel: FunctionalComponent<{ label: string; count?: number }> = (props) =>
  props.count && props.count > 0
    ? ([props.label, h("span", { class: "sf-count", "aria-label": `${props.count} unread` }, unreadBadge(props.count))] as unknown as VNode[])
    : (props.label as unknown as VNode);
RowLabel.props = ["label", "count"];
