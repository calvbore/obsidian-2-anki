> **Fork**: This is a fork of [ObsidianToAnki/Obsidian_to_Anki](https://github.com/ObsidianToAnki/Obsidian_to_Anki).

# Obsidian_to_Anki
Plugin to add flashcards from a text or markdown file to Anki. Run in Obsidian as a plugin, or from the command-line as a python script. Built with [Obsidian](https://obsidian.md/) markdown syntax in mind. Supports **user-defined custom syntax for flashcards.**  
See the [Trello](https://trello.com/b/6MXEizGg/obsidiantoanki) for planned features.

## Getting started

Check out the [Wiki](https://github.com/Pseudonium/Obsidian_to_Anki/wiki)! It has a ton of information, including setup instructions for new users. I will include a copy of the instructions here:

## Setup

### All users
1. Start up [Anki](https://apps.ankiweb.net/), and navigate to your desired profile.
2. Ensure that you've installed [AnkiConnect](https://git.foosoft.net/alex/anki-connect).

### Obsidian plugin users
3. Have [Obsidian](https://obsidian.md/) downloaded
4. Since this fork is not in the community plugin store, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):
   - BRAT Settings → Add Beta Plugin → paste `https://github.com/calvbore/obsidian-2-anki`
5. In Anki, navigate to Tools->Addons->AnkiConnect->Config, and change it to look like this:
<pre>
{
    "apiKey": null,
    "apiLogPath": null,
    "webBindAddress": "127.0.0.1",
    "webBindPort": 8765,
    "webCorsOrigin": "http://localhost",
    "webCorsOriginList": [
        "http://localhost",
        "app://obsidian.md"
    ]
}
</pre>

6. Restart Anki to apply the above changes
7. With Anki running in the background, load the plugin. This will generate the plugin settings.


You shouldn't need Anki running to load Obsidian in the future, though of course you will need it for using the plugin!

To run the plugin, look for an Anki icon on your ribbon (the place where buttons such as 'open Graph view' and 'open Quick Switcher' are).
For more information on use, please check out the [Wiki](https://github.com/Pseudonium/Obsidian_to_Anki/wiki)!

### Python script users
3. Install the latest version of [Python](https://www.python.org/downloads/).
4. If you are a new user, download `obstoanki_setup.py` from the [releases page](https://github.com/Pseudonium/Obsidian_to_Anki/releases), and place it in the folder you want the script installed (for example your notes folder).  
5. Run `obstoanki_setup.py`, for example by double-clicking it in a file explorer. This will download the latest version of the script and required dependencies automatically. Existing users should be able to run their existing `obstoanki_setup.py` to get the latest version of the script.  
6. Check the Permissions tab below to ensure the script is able to run.
7. Run `obsidian_to_anki.py`, for example by double-clicking it in a file explorer. This will generate a config file, `obsidian_to_anki_config.ini`.

#### Permissions
The script needs to be able to:
* Make a config file in the directory the script is installed.
* Read the file in the directory the script is used.
* Make a backup file in the directory the script is used.
* Rename files in the directory the script is used.
* Remove a backup file in the directory the script is used.
* Change the current working directory temporarily (so that local image paths are resolved correctly).

## Features

Current features (check out the wiki for more details):
* **Custom note types** - You're not limited to the 6 built-in note types of Anki.
* **Custom scan directory** 
  * The plugin will scan the entire vault by default
  * You can also set which directory (includes all sub-directories as well) to scan via plugin settings
* **Ignore Folders and Files**
  * You can specify which files and folders to ignore 
  * This can be done in the settings of this plugin with [Glob syntax](https://en.wikipedia.org/wiki/Glob_(programming)#Syntax).
  * If you're working on your own globs, you can test them out [here](https://globster.xyz/)
  * Examples:
    * `**/*.excalidraw.md` - Ignore all files that end in `.excalidraw.md`
      * => avoids excalidraw files from being scanned which can be extremely slow
    * `Template/**` - Ignore all files in the `Template` folder (including subfolders)
    * `**/private/**` - Ignore all files in folders that are called `private` no matter where they are in the vault
    * `[Pp]rivate*/**` - Ignore all files and folders in the root of the vault that start with `private` or with `Private`
* **Updating notes from file** - Your text files are the canonical source of the notes.
* **Tags**, including **tags for an entire file**.
* **Adding to user-specified deck** on a *per-file* basis.
* **Markdown formatting**.
* **Math formatting**.
* **Embedded images**. GIFs should work too.
* **Audio**.
* **Auto-deleting notes from the file**.
* **Reading from all files in a directory automatically** - recursively too!
* **Inline Notes** - Shorter syntax for typing out notes on a single line.
* **Easy cloze formatting** - A more compact syntax to do Cloze text. Cloze content containing LaTeX brace groups (e.g. `{{c1::a^{1}}}` or `\frac{a^{1}}{2}`) is normalized so Anki renders it correctly, and literal `{{cN::…}}` text in non-cloze note types is left untouched.
* **Frozen Fields**
* **Image Occlusion** - Turn `Image Occlusion` frames in an `.excalidraw.md` file (marked with `anki-occlusion: true` frontmatter) into stock Anki **Image Occlusion** notes. Rects/ellipses become cloze masks; every other object in the frame (images, text, arrows, shapes) is composited into a self-contained SVG card picture, so no image element is required. Each `## <name>` section below the drawing supplies the Header/Back Extra/Comments fields (their keys are the note type's own field names, like standard notes; plus a `Tags:` line for per-note tags; file tags come from a `FILE TAGS:` line as with any note; a `Hide all: true` line on the configured `Syntax > Hide All Line` hides all masks). Frames support the same `DELETE`/`FROZEN` lines and ID tagging as regular notes. Right-click an `.excalidraw.md` file for "Sync to Anki" (auto-opts an unmarked drawing in) and an Enable/Disable "Image Occlusion sync" toggle.
* **Obsidian integration** - A link to the file that made the flashcard, full link and image embed support.
* **Custom syntax** - Using **regular expressions**, add custom syntax to generate **notes that make sense for you.** Some examples:
  * RemNote single-line style. `This is how to use::Remnote single-line style`  
  ![Remnote 1](Images/Remnote_1.png)
  * Header paragraph style.
  <pre>
  # Style
  This style is suitable for having the header as the front, and the answer as the back
  </pre>  
  ![Header 1](Images/Header_1.png)
  * Question answer style.
  <pre>
  Q: How do you use this style?
  A: Just like this.
  </pre>  
  ![Question 1](Images/Question_1.png)
  * Neuracache #flashcard style.  
  <pre>
  In Neuracache style, to make a flashcard you do #flashcard
  The next lines then become the back of the flashcard
  </pre>  
  ![Neuracache 1](Images/Neuracache_1.png)
  * Ruled style  
  <pre>
  How do you use ruled style?
  ---
  You need at least three '-' between the front and back of the card.
  </pre>  
  ![Ruled 1](Images/Ruled_1.png)
  * Markdown table style  
  <pre>
  | Why might this style be useful? |
  | ------ |
  | It looks nice when rendered as HTML in a markdown editor. |
  </pre>
  ![Table 2](Images/Table_2.png)
  * Cloze paragraph style  
  <pre>
  The idea of {cloze paragraph style} is to be able to recognise any paragraphs that contain {cloze deletions}.
  </pre>
  ![Cloze 1](Images/Cloze_1.png)

Note that **all custom syntax is off by default**, and must be programmed into the script via the config file - see the Wiki for more details.

---

## Interactive sandbox (development only)

A Docker-based interactive test environment that runs Obsidian + Anki in a container with noVNC access.

```sh
npm run sandbox            # Quick mode (build once, start)
npm run sandbox -- --dev   # Dev mode (rollup watch + hot-reload)
npm run sandbox -- --dry-run  # Setup vault/config only, no Docker
```

Connect to `http://localhost:8080` (VNC password: `abc`). The vault is populated from all 34 test suites. Anki launches in dark mode by default. If Ctrl+C fails to stop the container:

```sh
npm run kill-sandbox
```

See `tests/README.md` for details.

## Acknowledgments

- [@Zennykenzo4210](https://github.com/Zennykenzo4210) — UI/UX redesign (tab-based settings, progress modal, status bar, context menu, and new sync commands) via [PR #673](https://github.com/ObsidianToAnki/Obsidian_to_Anki/pull/673).

