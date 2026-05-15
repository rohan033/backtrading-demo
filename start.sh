#!/bin/bash

# Backtrading Demo Startup Script
# This script activates the virtual environment, starts the backend server, and launches the frontend
# Can be run from anywhere - automatically finds the git root directory

echo "🚀 Starting Backtrading Demo..."

# Find git root directory
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "❌ Not in a git repository. Please run this script from within the project."
    exit 1
fi

echo "📁 Git root directory: $GIT_ROOT"
cd "$GIT_ROOT"

# Activate virtual environment
echo "📦 Activating virtual environment..."
source .ven/bin/activate

# Check if virtual environment is activated
if [[ "$VIRTUAL_ENV" != "" ]]; then
    echo "✅ Virtual environment activated: $VIRTUAL_ENV"
else
    echo "❌ Failed to activate virtual environment"
    exit 1
fi

# Start backend server in background
echo "🔧 Starting backend server..."
cd api
python3 server.py &
BACKEND_PID=$!
cd ..

# Wait a moment for backend to start
sleep 3

# Check if backend is running
if ps -p $BACKEND_PID > /dev/null; then
    echo "✅ Backend server started (PID: $BACKEND_PID)"
    echo "📡 Backend URL: http://localhost:8000"
else
    echo "❌ Backend server failed to start"
    exit 1
fi

# Start frontend development server
echo "🎨 Starting frontend development server..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

# Wait a moment for frontend to start
sleep 5

# Check if frontend is running
if ps -p $FRONTEND_PID > /dev/null; then
    echo "✅ Frontend development server started (PID: $FRONTEND_PID)"
    echo "🌐 Frontend URL: http://localhost:3000"
else
    echo "❌ Frontend development server failed to start"
    # Kill backend if frontend failed
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi

echo ""
echo "🎉 Both servers are running!"
echo "📊 Backend: http://localhost:8000"
echo "🖥️  Frontend: http://localhost:3000"
echo ""
echo "📝 Logs:"
echo "   Backend PID: $BACKEND_PID"
echo "   Frontend PID: $FRONTEND_PID"
echo ""
echo "🛑 To stop both servers, press Ctrl+C or run: kill $BACKEND_PID $FRONTEND_PID"
echo ""

# Function to cleanup processes on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down servers..."
    cd "$GIT_ROOT"
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    echo "✅ All servers stopped"
    exit 0
}

# Set trap to cleanup on Ctrl+C
trap cleanup INT

# Wait for user to stop the script
echo "⏳ Waiting... Press Ctrl+C to stop all servers"
wait
