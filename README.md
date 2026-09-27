# Утопия: Simultaneous Declarations

A [Foundry VTT](https://foundryvtt.com) module for the Утопия variant of [Lancer](https://massif-press.itch.io/corebook-pdf) ([rules](https://wirenook.net/arms-derby/)), played with the [Lancer system](https://github.com/CassidyPrather/foundryvtt-lancer).

Each round:

1. **Declare.** Everyone declares their actions and moves at the same time. Players lock in from the **Declare** window, which opens at the start of each round. Once locked in, you can't change your mind.
2. **Reveal.** The GM reveals every declaration at once in a chat card.
3. **Resolve**, in phases: PC actions, NPC actions, PC moves, NPC moves.

A banner on the combat tracker shows the round, the current phase and how many player characters have declared.

## For the GM

- Open **Declarations** from the combat tracker banner. It shows which player characters have declared, but not what they declared, until you reveal. Write the NPCs' declarations there.
- **Reveal** posts all declarations to chat. **Next** steps through the phases and, after NPC moves, starts the next round.
- If a player locked in by mistake, unlock their declaration from the Declarations window so they can declare again.
- Declarations are kept in the GM's browser until the reveal, so run the whole round from the same browser. They are hidden from the other players' screens, but this is not built to stop a player who goes digging with browser developer tools.

The Lancer system's world setting **Variant: Player Mechs Survive at 0 Structure/Stress** (Lancer 3.3.0 and later) covers Утопия's survival rule.

## Installation

In Foundry v14, go to **Setup → Add-on Modules → Install Module** and paste this manifest URL:

```
https://github.com/CassidyPrather/lancer-utopia/releases/latest/download/module.json
```

Then enable **Утопия: Simultaneous Declarations** in your Lancer world.

## License

[GNU Affero General Public License v3.0](LICENSE).
