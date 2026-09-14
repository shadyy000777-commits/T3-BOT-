// Locks or unlocks a group's channel for its role. Denying SendMessages +
// AttachFiles still leaves ViewChannel/ReadMessageHistory alone, so the
// group can always see what was said — they just can't post anything new
// once closed. Admins bypass this automatically via Discord's own
// Administrator permission, which ignores channel overwrites entirely.
//
// Thread permissions have to be locked down the exact same way as
// SendMessages/AttachFiles — otherwise, once SendMessages is denied,
// Discord itself flips the channel into "threads only" mode and shows a
// "Create Thread" button, letting players post inside a thread even while
// the channel is supposed to be closed. So CreatePublicThreads (new
// threads), CreatePrivateThreads, and SendMessagesInThreads (existing
// threads) all follow `open` too, in lockstep with SendMessages.
async function setGroupChannelOpen(channel, roleId, open, reason) {
  await channel.permissionOverwrites.edit(roleId, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: open,
    AttachFiles: open,
    CreatePublicThreads: open,
    CreatePrivateThreads: open,
    SendMessagesInThreads: open,
  }, { reason });
}

module.exports = { setGroupChannelOpen };
