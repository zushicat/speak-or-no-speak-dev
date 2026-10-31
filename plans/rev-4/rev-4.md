# Revision 4: Create docs
I want to create a documentaion about this VAD app.
The documentation shall be created in the directory [docs](/Users/karin/_programming/speak-or-no-speak/docs)
The documentation shall be indivual makdown pages for chapters. Subchapters *can* stay in one "chapter" markdown file (depending on their size).

**Note** the app is currently running on: http://localhost:5173/demo/

## Basics
I want the documentation to be a detailed explainer, starting with easy and basic stuff such as: 
- what it is and what it does
    - what is in not
- how to use it
    - start server for http and optinally for the python translate mockup
    - what the demo shows and does: [demo](/Users/karin/_programming/speak-or-no-speak/demo)
        - what the Python script is doing and what it is NOT doing
    - how to use the build bundle in your own app
- why the following libraries are not included in the bundle (hence why they need to be loaded seprately) and what they are there for
    - onnxruntime-web: https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js
    - vad-web: https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js

These are just examples that come to mind off the top of my head.

## Architecture and used Methods
Then I want to explain what is implemented and why.
I have used an AI model to create an architectural overview that can be opened as a weppapp (no server start needed): [docs/archify/speak-or-no-speak.architecture.html](/Users/karin/_programming/speak-or-no-speak/docs/archify/speak-or-no-speak.architecture.html)
This is screenshot of the page: [speak-or-no-speak-browser-turn-detection.png](/Users/karin/_programming/speak-or-no-speak/plans/rev-4/assets/speak-or-no-speak-browser-turn-detection.png)

In my very first initial development I let an AI model create an analysis of different VAD methods: [problem-analysis-initial.md](/Users/karin/_programming/speak-or-no-speak/plans/initial/problem-analysis-initial.md)
These were first steps and considerations to actually implement the webapp code: [src](/Users/karin/_programming/speak-or-no-speak/src)
This document may be helpful for any further explanation of used methods

## The current README files
Currently we have several different README files:
- [README.md](/Users/karin/_programming/speak-or-no-speak/README.md)
- [README-advanced.md](/Users/karin/_programming/speak-or-no-speak/README-advanced.md)
- [README-BUNDLE.md](/Users/karin/_programming/speak-or-no-speak/README-BUNDLE.md)

All 3 files have very important, helpful and informative information that shall be used as well.

I want to explain what is basically happening.

### The individual Javascript files
I want to explain what the individual Javascript files in src are actually doing.

## Your task
I want to have a detailed documentation as individual markdown files in the directory docs.
Therefore I want you to create a TOC first and store it in [docs/README.md](/Users/karin/_programming/speak-or-no-speak/docs/README.md) (I already created an empty README.md file.)
The TOC shall have chapters and subchapters (if necessary) and be detailed and comprehensive.

Create the TOC, only.
We will create the actual indivdual markdown files for the chapters later: First we concentrate on the structure of the content.