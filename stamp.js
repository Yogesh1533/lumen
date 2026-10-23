'use strict';
// The clock of the server.
//
// The chats carry the stamps "created" and "updated", and the list of the chats is
// sorted by them ("the most recent chat" is the one with the biggest stamp). The
// stamps must therefore be strictly increasing: two chats saved in the same
// millisecond must not tie, or the most recent chat is not well defined (the sort
// keeps the older chat first, and the app opens the wrong one).
let lastStamp = 0;
function nowStamp() {
  const t = Date.now();
  lastStamp = t > lastStamp ? t : lastStamp + 1;
  return lastStamp;
}
module.exports = { nowStamp };
