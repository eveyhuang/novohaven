import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications, Notification } from '../../context/NotificationContext';

export function Notifications() {
  const { notifications, removeNotification, backgroundExecutions } = useNotifications();
  const navigate = useNavigate();

  const handleViewExecution = (executionId: number, notificationId: string) => {
    removeNotification(notificationId);
    navigate(`/executions/${executionId}`);
  };

  return (
    <div className="fixed top-4 right-4 z-50 space-y-3 max-w-sm">
      {/* Background Execution Indicator */}
      {backgroundExecutions.length > 0 && (
        <div className="bg-blue-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center space-x-3">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
          <div className="flex-1">
            <p className="font-medium text-sm">
              {backgroundExecutions.length} workflow{backgroundExecutions.length > 1 ? 's' : ''} running
            </p>
            <p className="text-xs text-blue-100 truncate">
              {backgroundExecutions.map(e => e.recipeName).join(', ')}
            </p>
          </div>
          <button
            onClick={() => navigate('/executions')}
            className="text-xs text-blue-100 hover:text-white underline"
          >
            View
          </button>
        </div>
      )}

      {/* Notification Toasts */}
      {notifications.map((notification) => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onClose={() => removeNotification(notification.id)}
          onView={notification.executionId
            ? () => handleViewExecution(notification.executionId!, notification.id)
            : undefined
          }
        />
      ))}
    </div>
  );
}

interface NotificationToastProps {
  notification: Notification;
  onClose: () => void;
  onView?: () => void;
}

function NotificationToast({ notification, onClose, onView }: NotificationToastProps) {
  const bgColors = {
    success: 'bg-green-50 border-green-200',
    error: 'bg-red-50 border-red-200',
    info: 'bg-blue-50 border-blue-200',
    warning: 'bg-yellow-50 border-yellow-200',
  };

  const iconColors = {
    success: 'text-green-600',
    error: 'text-red-600',
    info: 'text-blue-600',
    warning: 'text-yellow-600',
  };

  const textColors = {
    success: 'text-green-800',
    error: 'text-red-800',
    info: 'text-blue-800',
    warning: 'text-yellow-800',
  };

  return (
    <div
      className={`${bgColors[notification.type]} border rounded-lg shadow-lg p-4 animate-slide-in-right`}
    >
      <div className="flex items-start space-x-3">
        <div className={`flex-shrink-0 ${iconColors[notification.type]}`}>
          <NotificationIcon type={notification.type} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-medium ${textColors[notification.type]}`}>
            {notification.title}
          </p>
          {notification.message && (
            <p className={`text-sm mt-1 ${textColors[notification.type]} opacity-80`}>
              {notification.message}
            </p>
          )}
          {onView && (
            <button
              onClick={onView}
              className={`text-sm mt-2 font-medium ${textColors[notification.type]} hover:underline`}
            >
              View Details →
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className={`flex-shrink-0 ${textColors[notification.type]} opacity-60 hover:opacity-100`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function NotificationIcon({ type }: { type: Notification['type'] }) {
  switch (type) {
    case 'success':
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case 'error':
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case 'info':
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case 'warning':
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      );
  }
}
