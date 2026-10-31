# Revision 3: Add Background Sounds to Demopage

## Permanent button for Start / Stop Microphone
Right now, after reloading the page: There is a "Start microphone" button. When I click this button, it disappears. So the microphone is always on and I can not turn it off.
I want the button to stay and the user can switch between start and stop by clicking that button.

## Background sounds
The current demopage [index.html](/Users/karin/_programming/speak-or-no-speak/index.html) has a section "Simulate agent answer"
```
<div id="agentRow" hidden>
    <select id="ttsVol" aria-label="TTS volume">
    <option value="0.3">30 %</option>
    <option value="0.5" selected>50 %</option>
    <option value="1">100 %</option>
    </select>
    <button id="agent">Simulate agent answer</button>
    <button id="agentStop" hidden>Stop agent</button>
</div>
```

I do not need that section.
Instead, I want to be able to load and play the mp3 files that I temporarily stored in this directory: [plans/rev-3/assets](/Users/karin/_programming/speak-or-no-speak/plans/rev-3/assets)
I described where the sounds come from as well as the content (kind of future naming) and the ioriginal filename.
I guess the mp3 files should be copied and pasted into an assets directory. (the plans directory and it's content is for planning, only and not really part of the commits)

Starting and stopping background noises shall replace the mentioned part above.
I also want a slider for the volume with the default to 50%.

The user shall be able to select the mp3 sound by a drop down and shall be able to turn the background sounds on and off ny button click.

## No sound saving
I do not need the "Save last turn (.wav)" part

## Your task
Create a plan for the above stuff and store it in [plan-rev-3.md](/Users/karin/_programming/speak-or-no-speak/plans/rev-3/plan-rev-3.md)