# Content-panel icons: icons/panel

The pixel sprites in the content-panel header bands (coach page, Account, My teams, tournaments, ...), shown at 22 px
before each band title. Wired in CSS only (spa/src/home/home.css, "Panel band icons"), keyed by each band's heading
id, so a heading without a rule gets no icon.

ATTRIBUTION: original Super FUMBBL site assets (drawn 10-30), in the same style as the sidebar icons (icons/nav):
16 x 16 pixel maps drawn by hand in tools/draw-panel-icons.py (run `python tools/draw-panel-icons.py` from
apps/config-web to rebuild; `--sheet X` writes a dark + light contact sheet) using the shared palette and renderer in
tools/pixel_icons.py, upscaled x4 nearest-neighbour to 64 x 64 PNG masters with a transparent background. 1 px dark
outline, 3-tone shading, greens / golds / browns / stone / blues, red only as a small accent. The 8/16-bit game look is
the inspiration; no sprite or asset is copied from any game, Nintendo, Games Workshop, TourPlay, FUMBBL or any other
property.

| File | Picture | Used for |
| --- | --- | --- |
| news.png | newspaper | What's new |
| notifications.png | hand bell | Notifications |
| deadlines.png | hourglass | Deadlines |
| games.png | football on a pitch square | Recent games |
| friends.png | two figures | Friends; My teams > Avatars |
| messages.png | sealed envelope | Messages; message-a-coach dialog |
| teams.png | banner with a helmet | My teams; Account > Teams; tournament My entry |
| calendar.png | calendar leaf | Account > Calendar; mini calendar |
| account.png | shield with a bust | Account (coach page); Account > Session |
| identity.png | nameplate | Account > Identity |
| schedule.png | clock | Schedule; Set schedule dialog |
| connections.png | chain link | Account > Connections |
| tournaments.png | laurel and star | Tournament list; tournament About |
| leagues.png | pennant | (league pages, once they have heading ids) |
| stats.png | bar chart | Leaderboards; tournament Summary |
| standings.png | podium | (standings, once it has a heading id) |
| fixtures.png | crossed swords | (fixtures, once it has a heading id) |
| honours.png | medal | (honours, once it has a heading id) |
| teams-roster.png | helmet | Submitted team / Library team; Build a team |
