You are an expert AI data engineer specializing in training lightweight text LLMs for local deployment on mobile (iPhone). I need you to generate a synthetic training dataset based on the attached document context.

The model acts as an advanced "Personal AI Fitness Trainer." It relies on two local on-device tools to fetch real-time health data or modify the user's permanent profile.

### Available Tools:
1. `get_user_health_data()` 
   - Returns Apple HealthKit metrics: {
       "age": int, 
       "weight_kg": float, 
       "height_cm": float, 
       "sex": string, 
       "pregnancy_status": bool, 
       "active_calories_burned": int, 
       "basal_energy_burned": int, 
       "exercise_minutes": int, 
       "stand_hours": int,
       "sleep_duration_hours": float,
       "hrv_ms": int,
       "resting_heart_rate_bpm": int
     }


### Strict Tool Usage & Reasoning Rules:
- Call `get_user_health_data` ONLY when specific real-time metrics, body dimensions, or recovery signs are strictly required for calculations or decisions outlined in the document (e.g., calculating BMI, verifying limits for the "10-kg-in-10-days" scenario, checking active ring progress, or evaluating if low sleep/HRV/elevated resting HR requires swapping high-intensity HIIT for recovery).
- Skip the tool entirely if the query can be answered using general document rules or static profile data (e.g., general allergy questions, static calorie targets already in the profile, prediabetes rules, or emotional/motivation topics).
- No Redundant Calls: Never re-call `get_user_health_data` if it has already been invoked earlier in the same conversation thread.

### JSON Schema to follow strictly:
[
  {
    "comment": "Example of a Read Tool Call evaluating recovery markers to modify training intensity",
    "messages": [
      {"role": "user", "content": "I have a heavy HIIT session planned today, but I'm feeling a bit sluggish. What do you think?"},
      {"role": "assistant", "content": "", "tool_calls": [{"id": "call_01", "type": "function", "function": {"name": "get_user_health_data", "arguments": {}}}]},
      {"role": "tool", "name": "get_user_health_data", "content": "{\"age\": 29, \"weight_kg\": 82.5, \"height_cm\": 180, \"sex\": \"male\", \"pregnancy_status\": false, \"active_calories_burned\": 110, \"basal_energy_burned\": 1850, \"exercise_minutes\": 5, \"stand_hours\": 3, \"sleep_duration_hours\": 5.2, \"hrv_ms\": 28, \"resting_heart_rate_bpm\": 78}"},
      {"role": "assistant", "content": "Looking at your data, your central nervous system is heavily fatigued: your resting heart rate is up to 78 bpm, you got just 5.2 hours of sleep, and your HRV dropped to 28 ms. Pushing through a heavy HIIT session today will delay your recovery. Based on our training guidelines, change today's workout to light mobility work or low-intensity steady-state (LISS) cardio to allow your body to bounce back."}
    ]
  },
  {
    "comment": "Example of Skipping the Tool (Emotional/Motivation scenario)",
    "messages": [
      {"role": "user", "content": "I'm feeling really unmotivated today and missed my workout. What should I do?"},
      {"role": "assistant", "content": "It is completely normal to have off days. According to our core principles, consistency matters more than perfection. Focus on a light stretching routine or a 10-minute walk today to keep momentum without forcing a heavy session."}
    ]
  }
]

### Rules for Generation:
- Output a single valid JSON list containing a highly diverse mix of the scenarios above.
- Ensure all final assistant responses are concise, mobile-optimised, and completely aligned with the guidelines in the provided context document.
- Generate [INSERT NUMBER, e.g., 40] total diverse conversation logs.


### Results:
use folder out for training results

### iOS App
Create the iOS iPhone app in the App folder.

The app should provide:

A simple chat interface for interacting with the trained model.
The company logo.
An “About Us” section.
Model and health data

The app will run the trained model and implement the get_user_health_data function. The model should be able to call this function when it needs the user’s health data.

#### RAG and references

The app will also use the RAG system and the files located in the RAG folder.

When the model uses information retrieved through RAG, it should present the relevant references to the user. The user should be able to tap a reference and open the corresponding .md file directly within the app.

The Markdown files should be rendered and formatted properly in the app rather than displayed as raw Markdown text.